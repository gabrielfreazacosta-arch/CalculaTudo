"use strict";

/* ==========================================================
   Constants
   ========================================================== */

const MAX_DIGITS = 15;
const MAX_HISTORY = 20;
const ABSOLUTE_MAX = 1e12;
const HISTORY_KEY = "calculators.history.v2";
const TAB_KEY = "calculators.tab.v1";
const TAB_NAMES = ["basic", "scientific", "prices", "bmi", "loan"];
const CALCULATOR_TABS = ["basic", "scientific"];
const SYMBOLS = { "+": "+", "-": "−", "*": "×", "/": "÷" };

const ERRORS = {
  divisionByZero: "Não é possível dividir por zero",
  overflow: "Resultado fora do limite",
  invalid: "Expressão inválida",
  domain: "Operação fora do domínio",
};

class CalcError extends Error {}

const formatters = {
  money: new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }),
  unitMoney: new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: "BRL",
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  }),
  oneDecimal: new Intl.NumberFormat("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 }),
  percent: new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 2 }),
  rate: new Intl.NumberFormat("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 4 }),
};

/* ==========================================================
   Shared helpers
   ========================================================== */

function formatNumber(raw) {
  if (raw.includes("e")) return raw.replace(".", ",");
  const negative = raw.startsWith("-");
  const unsigned = negative ? raw.slice(1) : raw;
  const [integerPart, decimalPart] = unsigned.split(".");
  const grouped = integerPart.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return (negative ? "-" : "") + grouped + (decimalPart !== undefined ? "," + decimalPart : "");
}

function roundResult(value) {
  return String(Number(value.toPrecision(12)));
}

/*
  Accepts Brazilian input. With a comma, dots are thousands separators ("1.234,56").
  Without a comma, a dot followed by exactly three digits groups is read as thousands
  ("1.500" is 1500), anything else as a decimal point ("1.5" is 1.5).
  Returns null for empty input and NaN for invalid input.
*/
function parseDecimal(raw) {
  let text = raw.trim().replace(/\s/g, "").replace(/^R\$/i, "");
  if (text === "") return null;
  if (text.includes(",")) text = text.replace(/\./g, "").replace(",", ".");
  else if (/^\d{1,3}(\.\d{3})+$/.test(text)) text = text.replace(/\./g, "");
  if (!/^-?(\d+\.?\d*|\.\d+)$/.test(text)) return NaN;
  return Number(text);
}

function readStorage(key) {
  try {
    return localStorage.getItem(key);
  } catch (error) {
    console.warn("Could not read from localStorage:", error);
    return null;
  }
}

function writeStorage(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch (error) {
    console.warn("Could not write to localStorage:", error);
  }
}

function renderScreen(screen, display, expressionEl, mainText, secondaryText, isError) {
  display.textContent = mainText;
  expressionEl.textContent = secondaryText;
  screen.classList.toggle("screen--error", isError);

  if (mainText.length > 14) screen.dataset.size = "sm";
  else if (mainText.length > 9) screen.dataset.size = "md";
  else delete screen.dataset.size;
}

/* ==========================================================
   History (shared by basic and scientific)
   ========================================================== */

const historyEls = {
  list: document.getElementById("historyList"),
  empty: document.getElementById("historyEmpty"),
  clear: document.getElementById("clearHistory"),
};

let history = loadHistory();
let activeTab = "basic";

function loadHistory() {
  try {
    const parsed = JSON.parse(readStorage(HISTORY_KEY) || "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((entry) =>
        entry &&
        CALCULATOR_TABS.includes(entry.mode) &&
        typeof entry.expression === "string" &&
        typeof entry.result === "string" &&
        Number.isFinite(parseFloat(entry.result))
      )
      .slice(0, MAX_HISTORY);
  } catch (error) {
    console.warn("Could not parse calculator history:", error);
    return [];
  }
}

function saveHistory() {
  writeStorage(HISTORY_KEY, JSON.stringify(history));
}

function addToHistory(mode, expression, result) {
  history.unshift({ mode, expression, result });
  if (history.length > MAX_HISTORY) history.length = MAX_HISTORY;
  saveHistory();
  renderHistory();
}

function renderHistory() {
  historyEls.list.replaceChildren();
  historyEls.empty.hidden = history.length > 0;
  historyEls.clear.disabled = history.length === 0;

  history.forEach((entry, index) => {
    const item = document.createElement("li");
    const button = document.createElement("button");
    const expression = document.createElement("span");
    const result = document.createElement("span");

    button.type = "button";
    button.className = "history__item";
    button.dataset.index = String(index);
    button.setAttribute("aria-label", `Reutilizar resultado ${formatNumber(entry.result)}`);

    expression.className = "history__expression";
    expression.textContent = entry.expression;
    result.className = "history__result";
    result.textContent = formatNumber(entry.result);

    button.append(expression, result);
    item.append(button);
    historyEls.list.append(item);
  });
}

/* ==========================================================
   Basic calculator
   ========================================================== */

function createBasicCalculator(panel) {
  const screen = panel.querySelector(".screen");
  const display = panel.querySelector(".screen__value");
  const expressionEl = panel.querySelector(".screen__expression");

  const state = {
    current: "0",
    previous: null,
    operator: null,
    overwrite: false,
    error: null,
    expression: "",
  };

  function reset() {
    state.current = "0";
    state.previous = null;
    state.operator = null;
    state.overwrite = false;
    state.error = null;
    state.expression = "";
  }

  function failWith(error) {
    if (!(error instanceof CalcError)) throw error;
    reset();
    state.error = error.message;
  }

  function applyOperator(a, b, operator) {
    const x = parseFloat(a);
    const y = parseFloat(b);
    let result;

    switch (operator) {
      case "+": result = x + y; break;
      case "-": result = x - y; break;
      case "*": result = x * y; break;
      case "/":
        if (y === 0) throw new CalcError(ERRORS.divisionByZero);
        result = x / y;
        break;
      default:
        throw new CalcError(ERRORS.invalid);
    }

    if (!Number.isFinite(result)) throw new CalcError(ERRORS.overflow);
    return roundResult(result);
  }

  function inputDigit(digit) {
    if (state.error) reset();

    if (state.overwrite) {
      state.current = digit;
      state.overwrite = false;
      return;
    }

    if (state.current === "0") {
      state.current = digit;
      return;
    }

    const digitCount = state.current.replace(/[-.]/g, "").length;
    if (digitCount < MAX_DIGITS) state.current += digit;
  }

  function inputDecimal() {
    if (state.error) reset();

    if (state.overwrite) {
      state.current = "0.";
      state.overwrite = false;
      return;
    }

    if (!state.current.includes(".")) state.current += ".";
  }

  function toggleSign() {
    if (state.error || state.current === "0") return;
    state.current = state.current.startsWith("-") ? state.current.slice(1) : "-" + state.current;
  }

  function backspace() {
    if (state.error || state.overwrite) return;
    const next = state.current.slice(0, -1);
    state.current = next === "" || next === "-" ? "0" : next;
  }

  function percent() {
    if (state.error) return;
    state.current = roundResult(parseFloat(state.current) / 100);
    state.overwrite = true;
  }

  function chooseOperator(operator) {
    if (state.error) return;

    if (state.operator && !state.overwrite) {
      try {
        const result = applyOperator(state.previous, state.current, state.operator);
        state.previous = result;
        state.current = result;
      } catch (error) {
        failWith(error);
        return;
      }
    } else if (!state.operator) {
      state.previous = state.current;
    }

    state.operator = operator;
    state.overwrite = true;
    state.expression = `${formatNumber(state.previous)} ${SYMBOLS[operator]}`;
  }

  function equals() {
    if (state.error || !state.operator || state.previous === null) return;

    const left = state.previous;
    const right = state.current;
    const operator = state.operator;

    try {
      const result = applyOperator(left, right, operator);
      const expressionText = `${formatNumber(left)} ${SYMBOLS[operator]} ${formatNumber(right)} =`;
      addToHistory("basic", expressionText, result);

      state.expression = expressionText;
      state.current = result;
      state.previous = null;
      state.operator = null;
      state.overwrite = true;
    } catch (error) {
      failWith(error);
    }
  }

  function render() {
    renderScreen(
      screen,
      display,
      expressionEl,
      state.error ? "Erro" : formatNumber(state.current),
      state.error || state.expression,
      Boolean(state.error)
    );
  }

  function handleAction(button) {
    const { action, value } = button.dataset;

    switch (action) {
      case "digit": inputDigit(value); break;
      case "decimal": inputDecimal(); break;
      case "operator": chooseOperator(value); break;
      case "equals": equals(); break;
      case "negate": toggleSign(); break;
      case "backspace": backspace(); break;
      case "percent": percent(); break;
      case "clear": reset(); break;
      default: return;
    }

    render();
  }

  function useResult(result) {
    reset();
    state.current = result;
    state.overwrite = true;
    render();
  }

  panel.querySelector(".keys").addEventListener("click", (event) => {
    const button = event.target.closest("button[data-action]");
    if (button) handleAction(button);
  });

  render();
  return { panel, handleAction, useResult };
}

/* ==========================================================
   Scientific calculator (no eval: tokenizer and recursive descent parser)
   ========================================================== */

const TOKEN_NAMES = ["asin", "acos", "atan", "sqrt", "sin", "cos", "tan", "log", "ln", "pi", "e"];
const FUNCTION_NAMES = new Set(["asin", "acos", "atan", "sqrt", "sin", "cos", "tan", "log", "ln"]);
const CONSTANTS = { pi: Math.PI, e: Math.E };

function tokenize(source) {
  const tokens = [];
  let index = 0;

  while (index < source.length) {
    const char = source[index];
    const rest = source.slice(index);

    if (/\s/.test(char)) {
      index += 1;
      continue;
    }

    if (/[0-9.]/.test(char)) {
      const match = /^(?:\d+\.?\d*|\.\d+)/.exec(rest);
      if (!match) throw new CalcError(ERRORS.invalid);
      tokens.push({ type: "number", value: Number(match[0]) });
      index += match[0].length;
      continue;
    }

    if (/[a-z]/.test(char)) {
      const name = TOKEN_NAMES.find((candidate) => rest.startsWith(candidate));
      if (!name) throw new CalcError(ERRORS.invalid);
      tokens.push({ type: FUNCTION_NAMES.has(name) ? "func" : "const", name });
      index += name.length;
      continue;
    }

    if ("+-*/^!()".includes(char)) {
      tokens.push({ type: "op", value: char });
      index += 1;
      continue;
    }

    throw new CalcError(ERRORS.invalid);
  }

  return tokens;
}

function checkFinite(value) {
  if (Number.isNaN(value)) throw new CalcError(ERRORS.domain);
  if (!Number.isFinite(value)) throw new CalcError(ERRORS.overflow);
  return value;
}

function factorial(value) {
  if (!Number.isInteger(value) || value < 0) throw new CalcError(ERRORS.domain);
  if (value > 170) throw new CalcError(ERRORS.overflow);
  let result = 1;
  for (let i = 2; i <= value; i += 1) result *= i;
  return result;
}

function applyFunction(name, x, angleMode) {
  const toRadians = (value) => (angleMode === "deg" ? (value * Math.PI) / 180 : value);
  const fromRadians = (value) => (angleMode === "deg" ? (value * 180) / Math.PI : value);
  const clean = (value) => (Math.abs(value) < 1e-12 ? 0 : value);

  switch (name) {
    case "sin": return clean(Math.sin(toRadians(x)));
    case "cos": return clean(Math.cos(toRadians(x)));
    case "tan": {
      const radians = toRadians(x);
      if (Math.abs(Math.cos(radians)) < 1e-12) throw new CalcError(ERRORS.domain);
      return clean(Math.tan(radians));
    }
    case "asin":
      if (x < -1 || x > 1) throw new CalcError(ERRORS.domain);
      return fromRadians(Math.asin(x));
    case "acos":
      if (x < -1 || x > 1) throw new CalcError(ERRORS.domain);
      return fromRadians(Math.acos(x));
    case "atan": return fromRadians(Math.atan(x));
    case "ln":
      if (x <= 0) throw new CalcError(ERRORS.domain);
      return Math.log(x);
    case "log":
      if (x <= 0) throw new CalcError(ERRORS.domain);
      return Math.log10(x);
    case "sqrt":
      if (x < 0) throw new CalcError(ERRORS.domain);
      return Math.sqrt(x);
    default:
      throw new CalcError(ERRORS.invalid);
  }
}

function evaluateExpression(source, angleMode) {
  const tokens = tokenize(source);
  let position = 0;

  const peek = () => tokens[position];
  const next = () => tokens[position++];
  const isOp = (token, value) => Boolean(token) && token.type === "op" && token.value === value;
  const startsOperand = (token) =>
    Boolean(token) && (token.type === "number" || token.type === "const" || token.type === "func" || isOp(token, "("));

  function expectClose() {
    if (!isOp(next(), ")")) throw new CalcError(ERRORS.invalid);
  }

  function parseExpression() {
    let value = parseTerm();
    while (isOp(peek(), "+") || isOp(peek(), "-")) {
      const operator = next().value;
      const right = parseTerm();
      value = operator === "+" ? value + right : value - right;
    }
    return value;
  }

  function parseTerm() {
    let value = parseUnary();
    for (;;) {
      const token = peek();
      if (isOp(token, "*") || isOp(token, "/")) {
        next();
        const right = parseUnary();
        if (token.value === "/") {
          if (right === 0) throw new CalcError(ERRORS.divisionByZero);
          value /= right;
        } else {
          value *= right;
        }
      } else if (startsOperand(token)) {
        value *= parseUnary();
      } else {
        break;
      }
    }
    return value;
  }

  function parseUnary() {
    if (isOp(peek(), "-")) {
      next();
      return -parseUnary();
    }
    if (isOp(peek(), "+")) {
      next();
      return parseUnary();
    }
    return parsePower();
  }

  function parsePower() {
    const base = parsePostfix();
    if (isOp(peek(), "^")) {
      next();
      const exponent = parseUnary();
      return checkFinite(Math.pow(base, exponent));
    }
    return base;
  }

  function parsePostfix() {
    let value = parsePrimary();
    while (isOp(peek(), "!")) {
      next();
      value = factorial(value);
    }
    return value;
  }

  function parsePrimary() {
    const token = next();
    if (!token) throw new CalcError(ERRORS.invalid);

    if (token.type === "number") return token.value;
    if (token.type === "const") return CONSTANTS[token.name];

    if (token.type === "func") {
      if (!isOp(next(), "(")) throw new CalcError(ERRORS.invalid);
      const argument = parseExpression();
      expectClose();
      return checkFinite(applyFunction(token.name, argument, angleMode));
    }

    if (isOp(token, "(")) {
      const value = parseExpression();
      expectClose();
      return value;
    }

    throw new CalcError(ERRORS.invalid);
  }

  const result = parseExpression();
  if (position < tokens.length) throw new CalcError(ERRORS.invalid);
  return checkFinite(result);
}

function closeParentheses(source) {
  const opens = (source.match(/\(/g) || []).length;
  const closes = (source.match(/\)/g) || []).length;
  return opens > closes ? source + ")".repeat(opens - closes) : source;
}

function formatExpression(source) {
  return source
    .replace(/\./g, ",")
    .replace(/\*/g, "×")
    .replace(/\//g, "÷")
    .replace(/-/g, "−")
    .replace(/pi/g, "π")
    .replace(/sqrt\(/g, "√(");
}

function toExpressionNumber(result) {
  const isExponential = result.includes("e");
  const text = isExponential ? result.replace("e", "*10^") : result;
  return isExponential || text.startsWith("-") ? `(${text})` : text;
}

function createScientificCalculator(panel) {
  const screen = panel.querySelector(".screen");
  const display = panel.querySelector(".screen__value");
  const expressionEl = panel.querySelector(".screen__expression");
  const angleButton = panel.querySelector('[data-action="angle"]');

  const VALUE_END = /[\d)ei!]$/;
  const OPERATORS = "+-*/^";

  const state = {
    expression: "",
    result: null,
    lastExpression: "",
    error: null,
    angleMode: "deg",
  };

  function clearOutcome() {
    state.result = null;
    state.lastExpression = "";
  }

  function beginNewEntry() {
    if (state.result !== null) {
      state.expression = "";
      clearOutcome();
    }
  }

  function continueEntry() {
    if (state.result !== null) {
      state.expression = toExpressionNumber(state.result);
      clearOutcome();
    }
  }

  function appendDigit(digit) {
    beginNewEntry();
    const trailing = /[0-9.]*$/.exec(state.expression)[0];
    if (trailing.replace(".", "").length >= MAX_DIGITS) return;
    state.expression += digit;
  }

  function appendDecimal() {
    beginNewEntry();
    const trailing = /[0-9.]*$/.exec(state.expression)[0];
    if (trailing.includes(".")) return;
    state.expression += trailing === "" ? "0." : ".";
  }

  function appendOperator(operator) {
    continueEntry();
    const expression = state.expression;
    const last = expression.slice(-1);

    if (expression === "" || last === "(") {
      if (operator === "-") state.expression += "-";
      return;
    }

    if (OPERATORS.includes(last)) {
      const before = expression.slice(-2, -1);
      if (before === "" || before === "(") return;
      state.expression = expression.slice(0, -1) + operator;
      return;
    }

    state.expression += operator;
  }

  function appendFunction(name) {
    beginNewEntry();
    state.expression += `${name}(`;
  }

  function appendConstant(name) {
    beginNewEntry();
    state.expression += name;
  }

  function openParenthesis() {
    beginNewEntry();
    state.expression += "(";
  }

  function closeParenthesis() {
    if (state.result !== null) return;
    const opens = (state.expression.match(/\(/g) || []).length;
    const closes = (state.expression.match(/\)/g) || []).length;
    if (opens > closes && VALUE_END.test(state.expression)) state.expression += ")";
  }

  function appendFactorial() {
    continueEntry();
    if (VALUE_END.test(state.expression)) state.expression += "!";
  }

  function appendSquare() {
    continueEntry();
    if (VALUE_END.test(state.expression)) state.expression += "^2";
  }

  function backspace() {
    if (state.result !== null) return;
    state.expression = state.expression.replace(/(?:asin|acos|atan|sqrt|sin|cos|tan|log|ln)\($|pi$|.$/, "");
  }

  function clearAll() {
    state.expression = "";
    clearOutcome();
  }

  function toggleAngle() {
    state.angleMode = state.angleMode === "deg" ? "rad" : "deg";
    const isDegrees = state.angleMode === "deg";
    angleButton.textContent = isDegrees ? "Deg" : "Rad";
    angleButton.setAttribute(
      "aria-label",
      isDegrees ? "Ângulos em graus. Alternar para radianos" : "Ângulos em radianos. Alternar para graus"
    );
  }

  function equals() {
    if (state.result !== null || state.expression === "") return;

    const source = closeParentheses(state.expression);
    try {
      const value = roundResult(evaluateExpression(source, state.angleMode));
      const expressionText = `${formatExpression(source)} =`;
      addToHistory("scientific", expressionText, value);
      state.expression = source;
      state.lastExpression = expressionText;
      state.result = value;
    } catch (error) {
      if (!(error instanceof CalcError)) throw error;
      state.error = error.message;
    }
  }

  function getPreview() {
    if (/^-?[0-9.]*$/.test(state.expression)) return "";
    try {
      const value = roundResult(evaluateExpression(closeParentheses(state.expression), state.angleMode));
      return `= ${formatNumber(value)}`;
    } catch (error) {
      return "";
    }
  }

  function render() {
    let mainText;
    let secondaryText;

    if (state.error) {
      mainText = state.expression ? formatExpression(state.expression) : "0";
      secondaryText = state.error;
    } else if (state.result !== null) {
      mainText = formatNumber(state.result);
      secondaryText = state.lastExpression;
    } else {
      mainText = state.expression ? formatExpression(state.expression) : "0";
      secondaryText = getPreview();
    }

    renderScreen(screen, display, expressionEl, mainText, secondaryText, Boolean(state.error));
  }

  function handleAction(button) {
    const { action, value } = button.dataset;
    state.error = null;

    switch (action) {
      case "digit": appendDigit(value); break;
      case "decimal": appendDecimal(); break;
      case "operator": appendOperator(value); break;
      case "func": appendFunction(value); break;
      case "constant": appendConstant(value); break;
      case "paren":
        if (value === "(") openParenthesis();
        else closeParenthesis();
        break;
      case "factorial": appendFactorial(); break;
      case "square": appendSquare(); break;
      case "backspace": backspace(); break;
      case "clear": clearAll(); break;
      case "angle": toggleAngle(); break;
      case "equals": equals(); break;
      default: return;
    }

    render();
  }

  function useResult(result) {
    state.error = null;
    state.expression = toExpressionNumber(result);
    clearOutcome();
    render();
  }

  panel.querySelector(".keys").addEventListener("click", (event) => {
    const button = event.target.closest("button[data-action]");
    if (button) handleAction(button);
  });

  render();
  return { panel, handleAction, useResult };
}

/* ==========================================================
   Form based tools (prices, BMI, loan)
   ========================================================== */

function classifyBmi(bmi) {
  if (bmi < 18.5) return "Abaixo do peso";
  if (bmi < 25) return "Peso normal";
  if (bmi < 30) return "Sobrepeso";
  if (bmi < 35) return "Obesidade grau I";
  if (bmi < 40) return "Obesidade grau II";
  return "Obesidade grau III";
}

function buildBmiScale(bmi) {
  const scale = document.createElement("div");
  scale.className = "bmi-scale";
  scale.setAttribute("aria-hidden", "true");

  const track = document.createElement("div");
  track.className = "bmi-scale__track";
  for (let i = 1; i <= 5; i += 1) {
    const segment = document.createElement("span");
    segment.className = `bmi-scale__segment bmi-scale__segment--${i}`;
    track.append(segment);
  }

  const marker = document.createElement("span");
  marker.className = "bmi-scale__marker";
  const clamped = Math.min(40, Math.max(15, bmi));
  marker.style.left = `${((clamped - 15) / 25) * 100}%`;

  scale.append(track, marker);
  return scale;
}

function buildLoan({ amount, down, rate, ratePeriod, months, system }) {
  const principal = amount - down;
  const monthlyRate = ratePeriod === "year" ? Math.pow(1 + rate / 100, 1 / 12) - 1 : rate / 100;
  const growth = Math.pow(1 + monthlyRate, months);
  if (!Number.isFinite(growth)) throw new CalcError("Taxa e prazo geram valores fora do limite.");

  const fixedPayment = monthlyRate === 0 ? principal / months : (principal * monthlyRate) / (1 - 1 / growth);
  const constantAmortization = principal / months;

  const schedule = [];
  let balance = principal;
  let totalPaid = 0;

  for (let month = 1; month <= months; month += 1) {
    const interest = balance * monthlyRate;
    const amortization = system === "sac" ? constantAmortization : fixedPayment - interest;
    const payment = interest + amortization;
    balance = month === months ? 0 : Math.max(0, balance - amortization);
    totalPaid += payment;
    schedule.push({ month, payment, interest, amortization, balance });
  }

  const first = schedule[0];
  const last = schedule[schedule.length - 1];
  const rows = [
    system === "sac"
      ? { label: "Primeira parcela", value: formatters.money.format(first.payment), primary: true }
      : { label: "Parcela fixa", value: formatters.money.format(first.payment), primary: true },
  ];
  if (system === "sac") rows.push({ label: "Última parcela", value: formatters.money.format(last.payment) });
  rows.push(
    { label: "Valor financiado", value: formatters.money.format(principal) },
    { label: "Total pago em parcelas", value: formatters.money.format(totalPaid) },
    { label: "Total de juros", value: formatters.money.format(totalPaid - principal) },
    { label: "Taxa mensal equivalente", value: `${formatters.rate.format(monthlyRate * 100)}% ao mês` }
  );

  return {
    rows,
    table: {
      caption: "Tabela de amortização",
      headers: ["Mês", "Parcela", "Juros", "Amortização", "Saldo devedor"],
      rows: schedule.map((item) => [
        String(item.month),
        formatters.money.format(item.payment),
        formatters.money.format(item.interest),
        formatters.money.format(item.amortization),
        formatters.money.format(item.balance),
      ]),
    },
  };
}

const formDefinitions = {
  discount: {
    fields: {
      price: { label: "Preço original", prefix: "R$", placeholder: "199,90", min: 0, minExclusive: true },
      percent: { label: "Desconto", suffix: "%", placeholder: "15", min: 0, max: 100 },
    },
    compute: ({ price, percent }) => {
      const saving = (price * percent) / 100;
      return {
        rows: [
          { label: "Você paga", value: formatters.money.format(price - saving), primary: true },
          { label: "Você economiza", value: formatters.money.format(saving) },
        ],
      };
    },
  },

  compare: {
    fields: {
      priceA: { label: "Preço do produto A", prefix: "R$", placeholder: "12,90", min: 0, minExclusive: true },
      quantityA: { label: "Quantidade do produto A", placeholder: "500", min: 0, minExclusive: true },
      priceB: { label: "Preço do produto B", prefix: "R$", placeholder: "22,50", min: 0, minExclusive: true },
      quantityB: { label: "Quantidade do produto B", placeholder: "1000", min: 0, minExclusive: true },
    },
    compute: ({ priceA, quantityA, priceB, quantityB }) => {
      const unitA = priceA / quantityA;
      const unitB = priceB / quantityB;
      let verdict;

      if (Math.abs(unitA - unitB) < 1e-9) {
        verdict = "Mesmo preço por unidade";
      } else {
        const cheaper = unitA < unitB ? "A" : "B";
        const high = Math.max(unitA, unitB);
        const low = Math.min(unitA, unitB);
        const difference = ((high - low) / high) * 100;
        verdict = `Produto ${cheaper}, ${formatters.percent.format(difference)}% mais barato`;
      }

      return {
        rows: [
          { label: "Produto A, por unidade", value: formatters.unitMoney.format(unitA) },
          { label: "Produto B, por unidade", value: formatters.unitMoney.format(unitB) },
          { label: "Melhor compra", value: verdict, primary: true },
        ],
      };
    },
  },

  split: {
    fields: {
      total: { label: "Total da conta", prefix: "R$", placeholder: "240,00", min: 0, minExclusive: true, full: true },
      tip: { label: "Gorjeta", suffix: "%", placeholder: "10", min: 0, max: 100 },
      people: { label: "Pessoas", placeholder: "4", integer: true, min: 1, max: 1000 },
    },
    compute: ({ total, tip, people }) => {
      const tipValue = (total * tip) / 100;
      const grandTotal = total + tipValue;
      return {
        rows: [
          { label: "Gorjeta", value: formatters.money.format(tipValue) },
          { label: "Total com gorjeta", value: formatters.money.format(grandTotal) },
          { label: "Por pessoa", value: formatters.money.format(grandTotal / people), primary: true },
        ],
      };
    },
  },

  bmi: {
    fields: {
      weight: { label: "Peso", suffix: "kg", placeholder: "70", min: 2, max: 500 },
      height: { label: "Altura", suffix: "cm", placeholder: "175", min: 50, max: 272 },
    },
    compute: ({ weight, height }) => {
      const meters = height / 100;
      const bmi = Math.round((weight / (meters * meters)) * 10) / 10;
      const lowWeight = 18.5 * meters * meters;
      const highWeight = 24.9 * meters * meters;
      return {
        bmi,
        rows: [
          { label: "IMC", value: formatters.oneDecimal.format(bmi), primary: true },
          { label: "Classificação", value: classifyBmi(bmi) },
          {
            label: "Peso para IMC normal",
            value: `${formatters.oneDecimal.format(lowWeight)} a ${formatters.oneDecimal.format(highWeight)} kg`,
          },
        ],
      };
    },
    decorate: (container, output) => container.append(buildBmiScale(output.bmi)),
  },

  loan: {
    fields: {
      amount: { label: "Valor do bem", prefix: "R$", placeholder: "250000", min: 0, minExclusive: true, full: true },
      down: { label: "Entrada", prefix: "R$", placeholder: "0", min: 0, optional: true, full: true },
      rate: { label: "Taxa de juros", suffix: "%", placeholder: "1,2", min: 0, max: 1000 },
      ratePeriod: {
        label: "Período da taxa",
        type: "select",
        options: [
          { value: "month", label: "ao mês" },
          { value: "year", label: "ao ano" },
        ],
      },
      months: { label: "Prazo", suffix: "meses", placeholder: "240", integer: true, min: 1, max: 480 },
      system: {
        label: "Sistema",
        type: "select",
        options: [
          { value: "price", label: "Price" },
          { value: "sac", label: "SAC" },
        ],
      },
    },
    crossValidate: ({ amount, down }) =>
      down >= amount ? { down: "A entrada deve ser menor que o valor do bem." } : {},
    compute: buildLoan,
  },
};

function formatLimit(value) {
  return formatters.percent.format(value);
}

function validateField(spec, raw) {
  if (spec.type === "select") return { value: raw };

  const parsed = parseDecimal(raw);
  if (parsed === null) return spec.optional ? { value: 0 } : { empty: true };
  if (Number.isNaN(parsed)) return { error: "Digite um número válido, por exemplo 1500,50." };
  if (spec.integer && !Number.isInteger(parsed)) return { error: "Use um número inteiro." };

  if (spec.min !== undefined) {
    if (spec.minExclusive && parsed <= spec.min) return { error: `Deve ser maior que ${formatLimit(spec.min)}.` };
    if (!spec.minExclusive && parsed < spec.min) return { error: `Deve ser no mínimo ${formatLimit(spec.min)}.` };
  }

  const max = spec.max !== undefined ? spec.max : ABSOLUTE_MAX;
  if (parsed > max) return { error: `Deve ser no máximo ${formatLimit(max)}.` };

  return { value: parsed };
}

function createField(formName, name, spec) {
  const id = `${formName}-${name}`;

  const wrapper = document.createElement("div");
  wrapper.className = spec.full ? "field field--full" : "field";

  const label = document.createElement("label");
  label.className = "field__label";
  label.htmlFor = id;
  label.textContent = spec.label;

  const control = document.createElement("div");
  control.className = "field__control";

  let input;
  if (spec.type === "select") {
    input = document.createElement("select");
    spec.options.forEach((optionSpec) => {
      const option = document.createElement("option");
      option.value = optionSpec.value;
      option.textContent = optionSpec.label;
      input.append(option);
    });
  } else {
    input = document.createElement("input");
    input.type = "text";
    input.inputMode = spec.integer ? "numeric" : "decimal";
    input.autocomplete = "off";
    input.spellcheck = false;
    input.placeholder = spec.placeholder || "";
  }

  const error = document.createElement("p");
  error.className = "field__error";
  error.id = `${id}-error`;
  error.hidden = true;

  input.id = id;
  input.className = "field__input";
  input.dataset.field = name;
  input.setAttribute("aria-describedby", error.id);

  if (spec.prefix) {
    const prefix = document.createElement("span");
    prefix.className = "field__affix";
    prefix.setAttribute("aria-hidden", "true");
    prefix.textContent = spec.prefix;
    control.append(prefix);
  }

  control.append(input);

  if (spec.suffix) {
    const suffix = document.createElement("span");
    suffix.className = "field__affix";
    suffix.setAttribute("aria-hidden", "true");
    suffix.textContent = spec.suffix;
    control.append(suffix);
  }

  wrapper.append(label, control, error);
  return { wrapper, input, error };
}

function buildTable(tableSpec) {
  const wrap = document.createElement("div");
  wrap.className = "table-wrap";
  wrap.tabIndex = 0;
  wrap.setAttribute("role", "region");
  wrap.setAttribute("aria-label", tableSpec.caption);

  const table = document.createElement("table");
  table.className = "table";

  const caption = document.createElement("caption");
  caption.className = "sr-only";
  caption.textContent = tableSpec.caption;

  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");
  tableSpec.headers.forEach((header) => {
    const cell = document.createElement("th");
    cell.scope = "col";
    cell.textContent = header;
    headRow.append(cell);
  });
  thead.append(headRow);

  const tbody = document.createElement("tbody");
  const fragment = document.createDocumentFragment();
  tableSpec.rows.forEach((cells) => {
    const row = document.createElement("tr");
    cells.forEach((text, index) => {
      const cell = document.createElement(index === 0 ? "th" : "td");
      if (index === 0) cell.scope = "row";
      cell.textContent = text;
      row.append(cell);
    });
    fragment.append(row);
  });
  tbody.append(fragment);

  table.append(caption, thead, tbody);
  wrap.append(table);
  return wrap;
}

function renderResults(container, output) {
  const list = document.createElement("dl");
  list.className = "results__list";

  output.rows.forEach((row) => {
    const group = document.createElement("div");
    group.className = row.primary ? "results__row results__row--primary" : "results__row";
    const term = document.createElement("dt");
    const detail = document.createElement("dd");
    term.textContent = row.label;
    detail.textContent = row.value;
    group.append(term, detail);
    list.append(group);
  });

  const nodes = [list];
  if (output.table) nodes.push(buildTable(output.table));
  container.replaceChildren(...nodes);
}

function renderMessage(container, className, message) {
  const paragraph = document.createElement("p");
  paragraph.className = className;
  paragraph.textContent = message;
  container.replaceChildren(paragraph);
}

function setupForm(name, definition) {
  const form = document.querySelector(`[data-form="${name}"]`);
  const results = document.querySelector(`[data-results="${name}"]`);
  const fieldsHost = form.querySelector("[data-fields]");
  const controls = {};

  Object.entries(definition.fields).forEach(([fieldName, spec]) => {
    controls[fieldName] = createField(name, fieldName, spec);
    fieldsHost.append(controls[fieldName].wrapper);
  });

  function applyErrors(errors) {
    Object.entries(controls).forEach(([fieldName, parts]) => {
      const message = errors[fieldName];
      parts.error.textContent = message || "";
      parts.error.hidden = !message;
      parts.wrapper.classList.toggle("field--invalid", Boolean(message));
      if (message) parts.input.setAttribute("aria-invalid", "true");
      else parts.input.removeAttribute("aria-invalid");
    });
  }

  function update() {
    const values = {};
    const errors = {};
    let hasEmpty = false;

    Object.entries(definition.fields).forEach(([fieldName, spec]) => {
      const outcome = validateField(spec, controls[fieldName].input.value);
      if (outcome.empty) hasEmpty = true;
      else if (outcome.error) errors[fieldName] = outcome.error;
      else values[fieldName] = outcome.value;
    });

    if (!hasEmpty && Object.keys(errors).length === 0 && definition.crossValidate) {
      Object.assign(errors, definition.crossValidate(values));
    }

    applyErrors(errors);

    if (hasEmpty || Object.keys(errors).length > 0) {
      renderMessage(results, "results__empty", "Preencha os campos para ver o resultado.");
      return;
    }

    try {
      const output = definition.compute(values);
      renderResults(results, output);
      if (definition.decorate) definition.decorate(results, output);
    } catch (error) {
      if (!(error instanceof CalcError)) throw error;
      renderMessage(results, "results__error", error.message);
    }
  }

  form.addEventListener("input", update);
  form.addEventListener("change", update);
  form.addEventListener("submit", (event) => event.preventDefault());
  form.addEventListener("reset", () => setTimeout(update, 0));

  update();
}

/* ==========================================================
   Tabs
   ========================================================== */

const calculators = {
  basic: createBasicCalculator(document.getElementById("panel-basic")),
  scientific: createScientificCalculator(document.getElementById("panel-scientific")),
};

const tabsEl = document.getElementById("tabs");
const tabButtons = Array.from(tabsEl.querySelectorAll(".tab"));
const panels = Array.from(document.querySelectorAll(".panel"));
const workspace = document.getElementById("workspace");
const historyPanel = document.getElementById("history");

function activateTab(name, moveFocus = false) {
  activeTab = name;

  tabButtons.forEach((tab) => {
    const isActive = tab.dataset.tab === name;
    tab.setAttribute("aria-selected", String(isActive));
    tab.tabIndex = isActive ? 0 : -1;
    if (isActive) {
      tab.scrollIntoView({ block: "nearest", inline: "nearest" });
      if (moveFocus) tab.focus();
    }
  });

  panels.forEach((panel) => {
    panel.hidden = panel.id !== `panel-${name}`;
  });

  const showHistory = CALCULATOR_TABS.includes(name);
  workspace.dataset.history = showHistory ? "on" : "off";
  historyPanel.hidden = !showHistory;

  writeStorage(TAB_KEY, name);
}

tabsEl.addEventListener("click", (event) => {
  const tab = event.target.closest(".tab");
  if (tab) activateTab(tab.dataset.tab);
});

tabsEl.addEventListener("keydown", (event) => {
  const currentIndex = tabButtons.findIndex((tab) => tab.dataset.tab === activeTab);
  let nextIndex = null;

  if (event.key === "ArrowRight") nextIndex = (currentIndex + 1) % tabButtons.length;
  else if (event.key === "ArrowLeft") nextIndex = (currentIndex - 1 + tabButtons.length) % tabButtons.length;
  else if (event.key === "Home") nextIndex = 0;
  else if (event.key === "End") nextIndex = tabButtons.length - 1;

  if (nextIndex === null) return;
  event.preventDefault();
  activateTab(tabButtons[nextIndex].dataset.tab, true);
});

/* ==========================================================
   Global events
   ========================================================== */

historyEls.list.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-index]");
  if (!button) return;
  const entry = history[Number(button.dataset.index)];
  const calculator = calculators[activeTab];
  if (!entry || !calculator) return;
  calculator.useResult(entry.result);
});

historyEls.clear.addEventListener("click", () => {
  history = [];
  saveHistory();
  renderHistory();
});

document.addEventListener("keydown", (event) => {
  const calculator = calculators[activeTab];
  if (!calculator) return;
  if (event.ctrlKey || event.metaKey || event.altKey) return;
  if (!(event.target instanceof Element)) return;
  if (event.target.closest("input, select, textarea, .tabs, .history")) return;

  let key = event.key;
  if (key === ".") key = ",";
  if (key === "Enter") key = "=";

  const button = Array.from(calculator.panel.querySelectorAll("[data-key]")).find(
    (candidate) => candidate.dataset.key === key
  );
  if (!button) return;

  event.preventDefault();
  button.classList.add("is-pressed");
  setTimeout(() => button.classList.remove("is-pressed"), 120);
  calculator.handleAction(button);
});

/* ==========================================================
   Init
   ========================================================== */

Object.entries(formDefinitions).forEach(([name, definition]) => setupForm(name, definition));

renderHistory();

const savedTab = readStorage(TAB_KEY);
activateTab(TAB_NAMES.includes(savedTab) ? savedTab : "basic");