/* SQL Format — own tokenizer + formatter. The SQL is only re-spaced, never parsed into anything that runs. */
(function () {
  "use strict";
  var $ = S3.$;

  function set(s) { var o = Object.create(null); s.split(/\s+/).forEach(function (w) { if (w) o[w] = true; }); return o; }

  var RESERVED = set(
    "SELECT FROM WHERE GROUP BY HAVING ORDER LIMIT OFFSET FETCH FIRST NEXT ROWS ROW ONLY UNION ALL DISTINCT INTERSECT EXCEPT MINUS " +
    "INSERT INTO VALUES UPDATE SET DELETE RETURNING WITH RECURSIVE AS ON USING JOIN INNER LEFT RIGHT FULL OUTER CROSS NATURAL APPLY LATERAL " +
    "STRAIGHT_JOIN AND OR NOT NULL IS IN EXISTS BETWEEN LIKE ILIKE SIMILAR ESCAPE CASE WHEN THEN ELSE END ASC DESC NULLS LAST " +
    "CREATE ALTER DROP TRUNCATE RENAME TABLE VIEW INDEX UNIQUE PRIMARY KEY FOREIGN REFERENCES CONSTRAINT CHECK DEFAULT COLUMN ADD " +
    "IF REPLACE TEMPORARY TEMP CASCADE RESTRICT MATERIALIZED SCHEMA DATABASE SEQUENCE TRIGGER PROCEDURE FUNCTION RETURNS BEGIN COMMIT " +
    "ROLLBACK TRANSACTION GRANT REVOKE TO OVER PARTITION WINDOW RANGE UNBOUNDED PRECEDING FOLLOWING CURRENT FILTER WITHIN QUALIFY " +
    "CONFLICT DO NOTHING DUPLICATE IGNORE TOP PERCENT TIES FOR SHARE NOWAIT SKIP LOCKED TRUE FALSE UNKNOWN COLLATE INTERVAL " +
    "AUTO_INCREMENT IDENTITY GENERATED ALWAYS STORED VIRTUAL MERGE MATCHED EXPLAIN ANALYZE TIME ZONE YEAR MONTH DAY HOUR MINUTE SECOND " +
    "INT INTEGER SMALLINT BIGINT TINYINT DECIMAL NUMERIC REAL FLOAT DOUBLE PRECISION SERIAL BIGSERIAL BOOLEAN BOOL CHAR VARCHAR NCHAR " +
    "NVARCHAR TEXT BLOB CLOB BYTEA JSON JSONB UUID DATE DATETIME TIMESTAMP TIMESTAMPTZ VARYING");
  var FUNCS = set(
    "COUNT SUM AVG MIN MAX COALESCE NULLIF CAST CONVERT TRY_CAST EXTRACT SUBSTRING SUBSTR TRIM LTRIM RTRIM UPPER LOWER LENGTH " +
    "CHAR_LENGTH CONCAT CONCAT_WS ROUND FLOOR CEIL CEILING ABS MOD POWER SQRT NOW CURRENT_DATE CURRENT_TIMESTAMP DATE_TRUNC DATE_PART " +
    "DATEADD DATEDIFF TO_CHAR TO_DATE STRING_AGG ARRAY_AGG GROUP_CONCAT JSON_AGG JSON_BUILD_OBJECT ROW_NUMBER RANK DENSE_RANK NTILE " +
    "LAG LEAD FIRST_VALUE LAST_VALUE GREATEST LEAST IFNULL ISNULL NVL POSITION REPLACE LEFT RIGHT IF IIF FORMAT UNNEST GENERATE_SERIES");
  // Multi-word keywords, longest first.
  var PHRASES = [
    "INSERT IGNORE INTO", "ON DUPLICATE KEY UPDATE", "IS NOT DISTINCT FROM", "CREATE OR REPLACE VIEW", "CREATE OR REPLACE FUNCTION",
    "CREATE MATERIALIZED VIEW", "CREATE UNIQUE INDEX", "LEFT OUTER JOIN", "RIGHT OUTER JOIN", "FULL OUTER JOIN", "DO UPDATE SET",
    "IS DISTINCT FROM", "WITH RECURSIVE", "SELECT DISTINCT", "SELECT ALL", "GROUP BY", "ORDER BY", "PARTITION BY", "UNION ALL",
    "UNION DISTINCT", "INTERSECT ALL", "EXCEPT ALL", "INSERT INTO", "REPLACE INTO", "DELETE FROM", "LEFT JOIN", "RIGHT JOIN",
    "FULL JOIN", "INNER JOIN", "CROSS JOIN", "NATURAL JOIN", "CROSS APPLY", "OUTER APPLY", "ON CONFLICT", "FOR UPDATE", "FOR SHARE",
    "ON UPDATE", "ON DELETE", "CREATE TABLE", "CREATE VIEW", "CREATE INDEX", "CREATE SCHEMA", "CREATE FUNCTION", "ALTER TABLE",
    "DROP TABLE", "DROP VIEW", "DROP INDEX", "PRIMARY KEY", "FOREIGN KEY", "NOT NULL", "IS NOT", "NOT IN", "NOT EXISTS",
    "NOT LIKE", "NOT BETWEEN"
  ].map(function (p) { return p.split(" "); }).sort(function (a, b) { return b.length - a.length; });

  var CLAUSE = set("SELECT|SELECT_DISTINCT|SELECT_ALL|FROM|WHERE|GROUP_BY|HAVING|ORDER_BY|LIMIT|OFFSET|FETCH|INSERT_INTO|REPLACE_INTO|INSERT_IGNORE_INTO|VALUES|DELETE_FROM|RETURNING|WINDOW|QUALIFY|DO_UPDATE_SET|ON_DUPLICATE_KEY_UPDATE".split("|").join(" "));
  var SETOP = set("UNION UNION_ALL UNION_DISTINCT INTERSECT INTERSECT_ALL EXCEPT EXCEPT_ALL MINUS");
  var JOINS = set("JOIN LEFT_JOIN RIGHT_JOIN FULL_JOIN INNER_JOIN CROSS_JOIN NATURAL_JOIN LEFT_OUTER_JOIN RIGHT_OUTER_JOIN FULL_OUTER_JOIN CROSS_APPLY OUTER_APPLY STRAIGHT_JOIN");
  // Words written like functions: keep "VARCHAR(100)" tight, as typed.
  var TIGHT = set("INT INTEGER SMALLINT BIGINT TINYINT DECIMAL NUMERIC REAL FLOAT DOUBLE CHAR VARCHAR NCHAR NVARCHAR TEXT BLOB " +
    "TIMESTAMP TIMESTAMPTZ TIME DATETIME VARYING FILTER IDENTITY CHECK KEY UNIQUE");
  var OPS = ["->>", "#>>", "<=>", "!=", "<>", "<=", ">=", "||", "::", "->", "#>", "@>", "<@", "&&", ":=", "=>", "**", "!~", "~*"];

  // ---------------- tokenizer ----------------
  // Each token: {type, v, ws (whitespace before), nl (that whitespace had a newline)}
  function scanQuoted(s, i, q, allowBackslash) {
    var j = i + 1;
    while (j < s.length) {
      var c = s[j];
      if (allowBackslash && c === "\\") { j += 2; continue; }
      if (c === q) { if (s[j + 1] === q) { j += 2; continue; } return j + 1; }
      j++;
    }
    return -1;
  }
  function tokenize(s) {
    var toks = [], i = 0, ws = "", m, n = s.length, bad = false;
    function push(type, v) { toks.push({ type: type, v: v, ws: ws, nl: /\n/.test(ws), bad: bad }); ws = ""; bad = false; }
    while (i < n) {
      var c = s[i], rest;
      if (/\s/.test(c)) { m = /^\s+/.exec(s.slice(i, i + 4096)); ws += m[0]; i += m[0].length; continue; }
      if (c === "-" && s[i + 1] === "-") { var e = s.indexOf("\n", i); if (e < 0) e = n; push("com", s.slice(i, e).replace(/\s+$/, "")); i = e; continue; }
      if (c === "/" && s[i + 1] === "*") { var e2 = s.indexOf("*/", i + 2); if (e2 < 0) bad = true; e2 = e2 < 0 ? n : e2 + 2; push("bcom", s.slice(i, e2)); i = e2; continue; }
      // strings, with optional N/E/X/B prefix
      var pre = 0;
      if (/[NnEeXxBb]/.test(c) && s[i + 1] === "'" && !/[\w$]/.test(s[i - 1] || "")) pre = 1;
      if (c === "'" || pre) {
        var q0 = i + pre, end = scanQuoted(s, q0, "'", true);
        if (end < 0) end = scanQuoted(s, q0, "'", false);
        if (end < 0) { end = n; bad = true; }
        push("str", s.slice(i, end)); i = end; continue;
      }
      if (c === "$") {
        m = /^\$([A-Za-z_]\w*)?\$/.exec(s.slice(i, i + 64));
        if (m) {
          var close = s.indexOf(m[0], i + m[0].length), e3 = close < 0 ? n : close + m[0].length; if (close < 0) bad = true;
          push("str", s.slice(i, e3)); i = e3; continue;
        }
        m = /^\$\d+/.exec(s.slice(i, i + 12));
        if (m) { push("var", m[0]); i += m[0].length; continue; }
      }
      if (c === '"' || c === "`") { var e4 = scanQuoted(s, i, c, false); if (e4 < 0) { e4 = n; bad = true; } push("qid", s.slice(i, e4)); i = e4; continue; }
      if (c === "[" && !/[\w)\]"]/.test(s[i - 1] || "")) {
        var e5 = s.indexOf("]", i);
        if (e5 > 0 && !/[\n\[]/.test(s.slice(i + 1, e5))) { push("qid", s.slice(i, e5 + 1)); i = e5 + 1; continue; }
      }
      rest = s.slice(i, i + 256);
      m = /^(?:0x[0-9a-fA-F]+|\d+\.?\d*(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?)/.exec(rest);
      if (m && !(c === "." && /[\w"`\])]/.test(s[i - 1] || ""))) { push("num", m[0]); i += m[0].length; continue; }
      m = /^[A-Za-z_@#\u{C0}-\u{FFFF}][\w$@#\u{C0}-\u{FFFF}]*/u.exec(rest);
      if (m) { push("word", m[0]); i += m[0].length; continue; }
      if ((c === ":" && s[i + 1] !== ":" && s[i - 1] !== ":" && /[A-Za-z_]/.test(s[i + 1] || "")) || c === "?") {
        m = c === "?" ? ["?"] : /^:[A-Za-z_]\w*/.exec(rest);
        push("var", m[0]); i += m[0].length; continue;
      }
      if (c === "(") { push("open", c); i++; continue; }
      if (c === ")") { push("close", c); i++; continue; }
      if (c === ",") { push("comma", c); i++; continue; }
      if (c === ";") { push("semi", c); i++; continue; }
      if (c === ".") { push("dot", c); i++; continue; }
      var op = null;
      for (var k = 0; k < OPS.length; k++) if (s.substr(i, OPS[k].length) === OPS[k]) { op = OPS[k]; break; }
      op = op || c;
      push("op", op); i += op.length;
    }
    if (ws) toks.push({ type: "eof", v: "", ws: ws, nl: /\n/.test(ws) });
    return classify(toks.filter(function (t) { return t.type !== "eof"; }));
  }

  function isCom(t) { return t && (t.type === "com" || t.type === "bcom"); }
  function nextSig(toks, i) { for (var j = i + 1; j < toks.length; j++) if (!isCom(toks[j])) return toks[j]; return null; }

  // words → keyword / function / identifier; merge multi-word keywords
  function classify(toks) {
    var out = [], prevSig = null;
    for (var i = 0; i < toks.length; i++) {
      var t = toks[i];
      if (t.type === "word") {
        var U = t.v.toUpperCase(), nx = toks[i + 1];
        if (prevSig && prevSig.type === "dot") { t.type = "word"; }
        else if (nx && nx.type === "open" && !nx.ws && (FUNCS[U] || !RESERVED[U])) { t.type = "fn"; t.U = U; }
        else if (RESERVED[U]) {
          t.type = "kw"; t.U = U;
          for (var p = 0; p < PHRASES.length; p++) {
            var ph = PHRASES[p], ok = ph[0] === U;
            for (var k = 1; ok && k < ph.length; k++) {
              var w = toks[i + k];
              ok = w && w.type === "word" && w.v.toUpperCase() === ph[k];
            }
            if (ok) {
              var words = [t.v];
              for (k = 1; k < ph.length; k++) words.push(toks[i + k].v);
              t = { type: "kw", v: words.join(" "), U: ph.join(" "), ws: t.ws, nl: t.nl, words: words };
              i += ph.length - 1; break;
            }
          }
        }
      }
      out.push(t);
      if (!isCom(t)) prevSig = t;
    }
    return out;
  }

  function applyCase(t, mode) {
    if (mode === "preserve") return t.v;
    if (t.type === "kw" || (t.type === "fn" && FUNCS[t.U])) return mode === "upper" ? t.v.toUpperCase() : t.v.toLowerCase();
    return t.v;
  }

  var CLS = { kw: "sf-k", fn: "sf-f", str: "sf-s", num: "sf-n", com: "sf-c", bcom: "sf-c", qid: "sf-q", op: "sf-o", var: "sf-v" };

  // ---------------- formatter ----------------
  function format(sql, opt) {
    opt = opt || {};
    var unit = opt.indent === "tab" ? "\t" : " ".repeat(+opt.indent || 2), kcase = opt.kwcase || "upper", leading = opt.commas === "leading";
    var toks = tokenize(sql), parts = [], lineIndent = 0, pending = null, blank = false, prev = null;
    var frames = [{ kind: "root", base: 0 }];
    function top() { return frames[frames.length - 1]; }
    function nl(level) { pending = level; }
    function emit(text, type, space) {
      if (parts.length && pending !== null) {
        parts.push(["\n" + (blank ? "\n" : "") + unit.repeat(pending), null]); lineIndent = pending;
      } else if (parts.length && space) parts.push([" ", null]);
      else if (!parts.length && pending !== null) lineIndent = pending;
      if (!parts.length && pending) parts.push([unit.repeat(pending), null]);
      pending = null; blank = false;
      parts.push([text, CLS[type] || null]);
    }
    function isWordish(t) { return t && /^(word|kw|fn|num|str|qid|var)$/.test(t.type); }
    function needSpace(p, t) {
      if (!p) return false;
      if (/^(comma|semi|close|dot)$/.test(t.type) || p.type === "open" || p.type === "dot") return false;
      if (t.v === "::" || p.v === "::") return false;
      if (p.unary) return false;
      if (t.type === "open") {
        if (p.type === "fn") return false;
        if (p.type === "kw") return TIGHT[p.U] ? !!t.ws : true;
        if (p.type === "word" || p.type === "qid") return !!t.ws;
        if (p.type === "close" || p.type === "open") return !!t.ws;
      }
      return true;
    }
    for (var i = 0; i < toks.length; i++) {
      var t = toks[i], f = top(), U = t.U || "", key = U.replace(/ /g, "_");
      if (isCom(t)) {
        if (!t.nl && parts.length) {
          var saved = pending; pending = null;
          emit(t.v, t.type, true);
          pending = saved !== null ? saved : (t.type === "com" ? lineIndent : null);
        } else {
          var lvl = pending !== null ? pending : lineIndent;
          if (parts.length) pending = lvl;
          emit(t.v, t.type, false);
          var nx = toks[i + 1];
          pending = t.type === "com" || (nx && nx.nl) ? lvl : null;
        }
        continue;
      }
      var text = applyCase(t, kcase), stmtScope = f.kind === "root" || f.kind === "sub";
      if (t.type === "op" && (t.v === "-" || t.v === "+") && (!prev || /^(op|open|comma|kw)$/.test(prev.type))) t.unary = true;

      if (t.type === "semi") {
        emit(text, "op", false);
        frames = [{ kind: "root", base: 0 }]; pending = 0; blank = true; prev = t; continue;
      }
      if (t.type === "kw" && stmtScope) {
        var atStart = !f.stmt;
        if (SETOP[key]) { nl(f.base); emit(text, t.type, true); nl(f.base); f.clause = null; prev = t; continue; }
        var isClause = CLAUSE[key] ||
          (key === "UPDATE" && (atStart || f.stmt === "WITH")) ||
          (key === "SET" && f.verb === "UPDATE") ||
          (key === "WITH" && atStart) || (key === "WITH_RECURSIVE" && atStart);
        if (isClause) {
          nl(f.base); emit(text, t.type, true); nl(f.base + 1);
          f.clause = key; if (!f.stmt) f.stmt = key;
          if (key === "UPDATE") f.verb = "UPDATE";
          prev = t; continue;
        }
        if (key === "ON_CONFLICT" || key === "FOR_UPDATE" || key === "FOR_SHARE") { nl(f.base); emit(text, t.type, true); f.clause = key; prev = t; continue; }
        if (JOINS[key]) { nl(f.base + 1); emit(text, t.type, true); f.clause = "JOIN"; prev = t; continue; }
        if (atStart && /^(CREATE|ALTER|DROP|TRUNCATE|SET|GRANT|REVOKE|BEGIN|COMMIT|ROLLBACK|EXPLAIN|MERGE)/.test(key)) {
          if (parts.length) nl(f.base);
          emit(text, t.type, true); f.stmt = key; f.clause = key; prev = t; continue;
        }
        if ((key === "AND" || key === "OR") && !f.between) {
          if (f.clause === "WHERE" || f.clause === "HAVING" || f.clause === "QUALIFY") nl(f.base + 1);
          else if (f.clause === "JOIN") nl(f.base + 2);
        }
        if (key === "AND" && f.between) f.between = false;
        if (key === "BETWEEN" || key === "NOT_BETWEEN") f.between = true;
      }
      if (t.type === "kw" && key === "CASE") {
        emit(text, t.type, needSpace(prev, t));
        frames.push({ kind: "case", inline: f.kind === "inline" || (f.kind === "case" && f.inline), level: lineIndent + 1 });
        prev = t; continue;
      }
      if (t.type === "kw" && f.kind === "case" && (key === "WHEN" || key === "ELSE" || key === "END")) {
        if (!f.inline) nl(key === "END" ? f.level - 1 : f.level);
        emit(text, t.type, true);
        if (key === "END") frames.pop();
        prev = t; continue;
      }
      if (t.type === "open") {
        var ns = nextSig(toks, i), nU = ns && ns.U || "";
        var kind = /^(SELECT|WITH)/.test(nU) ? "sub" :
          (f.kind === "root" && /^CREATE.*TABLE/.test(f.stmt || "") && !f.blockDone) ? "block" : "inline";
        emit(text, t.type, needSpace(prev, t));
        if (kind === "sub") { frames.push({ kind: "sub", base: lineIndent + 1, open: lineIndent }); nl(lineIndent + 1); }
        else if (kind === "block") { f.blockDone = true; frames.push({ kind: "block", level: lineIndent + 1, open: lineIndent }); nl(lineIndent + 1); }
        else frames.push({ kind: "inline" });
        prev = t; continue;
      }
      if (t.type === "close") {
        while (frames.length > 1 && top().kind === "case") frames.pop();
        var fr = frames.length > 1 ? frames.pop() : { kind: "inline" };
        if (fr.kind === "sub" || fr.kind === "block") nl(fr.open);
        emit(text, t.type, false);
        prev = t; continue;
      }
      if (t.type === "comma") {
        var level = f.kind === "block" ? f.level : stmtScope ? f.base + 1 : null;
        if (level === null) emit(text, "op", false);
        else if (leading) { nl(level); emit(text, "op", false); }
        else { emit(text, "op", false); nl(level); }
        prev = t; continue;
      }
      emit(text, t.type, needSpace(prev, t));
      prev = t;
    }
    return parts;
  }

  function minify(sql, keepComments) {
    var toks = tokenize(sql), out = [], prev = null;
    function wordish(t) { return /^(word|kw|fn|num|str|qid|var|bcom)$/.test(t.type); }
    toks.forEach(function (t) {
      var v = t.v;
      if (isCom(t)) {
        var hint = /^\/\*[+!]/.test(v);
        if (!keepComments && !hint) return;
        if (t.type === "com") { var body = v.slice(2).trim(); if (body.indexOf("*/") >= 0) return; v = "/* " + body + " */"; }
        t = { type: "bcom", v: v };
      }
      if (prev) {
        var a = prev, b = t, tight =
          a.type === "open" || a.type === "dot" || a.type === "comma" || a.type === "semi" ||
          /^(close|comma|semi|dot|open)$/.test(b.type) ||
          (a.type === "op" && wordish(b) && b.type !== "kw" && b.type !== "bcom") ||
          (b.type === "op" && wordish(a) && a.type !== "kw" && a.type !== "bcom" && a.type !== "close");
        if (a.type === "close" && b.type === "op") tight = true;
        if (b.type === "open" && a.type === "op") tight = false;
        if (a.type === "op" && b.type === "op") tight = tokenize(a.v + b.v).length === 2;
        if (a.type === "semi") out.push("\n");
        else if (!tight) out.push(" ");
      }
      out.push(v); prev = t;
    });
    return out.join("");
  }

  function partsText(parts) { return parts.map(function (p) { return p[0]; }).join(""); }
  function partsHtml(parts) {
    return parts.map(function (p) { return p[1] ? '<span class="' + p[1] + '">' + S3.esc(p[0]) + "</span>" : S3.esc(p[0]); }).join("");
  }
  // Highlight already-formatted text (used for minified output) by re-tokenizing it.
  function highlight(text) {
    var toks = tokenize(text), html = "";
    toks.forEach(function (t) { html += S3.esc(t.ws); html += CLS[t.type] ? '<span class="' + CLS[t.type] + '">' + S3.esc(t.v) + "</span>" : S3.esc(t.v); });
    return html;
  }

  // ---------------- UI ----------------
  var input = $("#input"), out = $("#out"), status = $("#status"), info = $("#info");
  var state = { text: "", mode: S3.store("sql.mode") || "format" };
  var opts = S3.store("sql.opts") || {};
  ["kwcase", "indent", "commas"].forEach(function (k) { if (opts[k]) $("#" + k).value = opts[k]; });
  if (opts.keepcom === false) $("#keepcom").checked = false;
  function readOpts() {
    var o = { kwcase: $("#kwcase").value, indent: $("#indent").value, commas: $("#commas").value, keepcom: $("#keepcom").checked };
    S3.store("sql.opts", o); return o;
  }

  function sig(toks) { return toks.filter(function (t) { return !isCom(t); }).map(function (t) { return /^(kw|fn|word)$/.test(t.type) ? t.v.toUpperCase().split(/\s+/).join(" ") : t.v; }).join("\u0001"); }

  function render(mode, fromAction) {
    var src = input.value;
    if (mode) { state.mode = mode; S3.store("sql.mode", mode); }
    if (!src.trim()) { out.textContent = ""; state.text = ""; status.className = "chip"; status.textContent = "Waiting for SQL"; info.textContent = ""; return; }
    var o = readOpts(), html;
    if (state.mode === "minify") { state.text = minify(src, o.keepcom); html = highlight(state.text); }
    else { var parts = format(src, o); state.text = partsText(parts); html = partsHtml(parts); }
    out.innerHTML = html;
    var unclosed = tokenize(src).some(function (t) { return t.bad; });
    var stmts = tokenize(src).filter(function (t) { return t.type === "semi"; }).length;
    status.className = "chip " + (unclosed ? "warn" : "ok");
    status.textContent = unclosed ? "Unclosed quote or comment" : (state.mode === "minify" ? "Minified" : "Formatted");
    info.textContent = S3.fmtBytes(new Blob([src]).size) + " → " + S3.fmtBytes(new Blob([state.text]).size) + " · " + state.text.split("\n").length + " lines" + (stmts > 1 ? " · " + stmts + " statements" : "");
    if (fromAction) S3.done();
  }

  var SAMPLE = "-- monthly revenue per active customer\nwith recent as (select customer_id, sum(total) as revenue, count(*) orders from orders o where o.created_at >= date '2026-01-01' and o.status in ('paid','shipped') group by customer_id having count(*) > 1)\n" +
    "select c.id, c.name, r.revenue, case when r.revenue > 1000 then 'gold' when r.revenue > 250 then 'silver' else 'bronze' end as tier, " +
    "(select max(created_at) from orders x where x.customer_id = c.id) last_order from customers c inner join recent r on r.customer_id = c.id " +
    "left join regions g on g.id = c.region_id and g.active = true where c.deleted_at is null and c.name not like 'Test%' order by r.revenue desc limit 50;\n" +
    "update customers set tier = 'gold', updated_at = now() where id in (1, 2, 3);";

  ["kwcase", "indent", "commas", "keepcom"].forEach(function (id) { $("#" + id).addEventListener("change", function () { render(); }); });
  input.addEventListener("input", S3.debounce(function () { render(); }, 250));
  $("#format").addEventListener("click", function () { render("format", true); });
  $("#minify").addEventListener("click", function () { render("minify", true); });
  $("#clear").addEventListener("click", function () { input.value = ""; render(); input.focus(); });
  $("#sample").addEventListener("click", function () { input.value = SAMPLE; render("format"); });
  $("#open input").addEventListener("change", function (e) {
    var f = e.target.files[0]; if (!f) return;
    S3.readFile(f, "text").then(function (t) { input.value = t; render(); });
    e.target.value = "";
  });
  input.addEventListener("dragover", function (e) { e.preventDefault(); });
  input.addEventListener("drop", function (e) {
    var f = e.dataTransfer.files[0]; if (!f) return;
    e.preventDefault(); S3.readFile(f, "text").then(function (t) { input.value = t; render(); });
  });
  input.addEventListener("keydown", function (e) { if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); render("format", true); } });
  $("#copy").addEventListener("click", function () { if (state.text) { S3.copy(state.text); S3.done(); } else S3.toast("Nothing to copy yet", "error"); });
  $("#save").addEventListener("click", function () { if (state.text) { S3.download(state.text, "query.sql", "application/sql"); S3.done(); } });

  window.S3_DEMO = function () { $("#sample").click(); };

  // ---------------- self-test ----------------
  window.S3_SELFTEST = function () {
    var fails = [];
    function eq(name, a, b) { if (a !== b) fails.push(name + ": got " + JSON.stringify(a) + " want " + JSON.stringify(b)); }
    var F = function (s, o) { return partsText(format(s, o || {})); };
    eq("basic", F("select a, b from t where x = 1 and y = 2"), "SELECT\n  a,\n  b\nFROM\n  t\nWHERE\n  x = 1\n  AND y = 2");
    eq("leading commas", F("select a,b from t", { commas: "leading" }), "SELECT\n  a\n  , b\nFROM\n  t");
    eq("lower + 4", F("SELECT a FROM t", { kwcase: "lower", indent: "4" }), "select\n    a\nfrom\n    t");
    eq("between", F("select a from t where a between 1 and 5 and b = 2"), "SELECT\n  a\nFROM\n  t\nWHERE\n  a BETWEEN 1 AND 5\n  AND b = 2");
    eq("subquery", F("select * from t where id in (select id from u)"), "SELECT\n  *\nFROM\n  t\nWHERE\n  id IN (\n    SELECT\n      id\n    FROM\n      u\n  )");
    eq("case", F("select case when a=1 then 'x' else 'y' end as c from t"), "SELECT\n  CASE\n    WHEN a = 1 THEN 'x'\n    ELSE 'y'\n  END AS c\nFROM\n  t");
    eq("functions inline", F("select count(*), extract(year from d) from t"), "SELECT\n  COUNT(*),\n  EXTRACT(YEAR FROM d)\nFROM\n  t");
    eq("join", F("select * from a left join b on a.id=b.id and b.x=1"), "SELECT\n  *\nFROM\n  a\n  LEFT JOIN b ON a.id = b.id\n    AND b.x = 1");
    eq("create", F("create table u (id int primary key, name varchar(100) not null);"), "CREATE TABLE u (\n  id INT PRIMARY KEY,\n  name VARCHAR(100) NOT NULL\n);");
    eq("insert", F("insert into t (a, b) values (1, 'x'), (2, 'y')"), "INSERT INTO\n  t (a, b)\nVALUES\n  (1, 'x'),\n  (2, 'y')");
    eq("cast + neg", F("select a::text, -1, b - 2 from t"), "SELECT\n  a::TEXT,\n  -1,\n  b - 2\nFROM\n  t");
    // tricky tokens: comment markers inside strings, doubled quotes, quoted identifiers, dollar quotes
    var tricky = "select 'it''s -- not a comment', \"weird \"\" col\", `x y`, $$a;b$$, E'a\\'b' /* c1 */ from t -- tail\nwhere s = '/* nope */';";
    var tt = tokenize(tricky).map(function (t) { return t.type + ":" + t.v; });
    eq("tok str", tt[1], "str:'it''s -- not a comment'"); eq("tok qid", tt[3], "qid:\"weird \"\" col\"");
    eq("tok bq", tt[5], "qid:`x y`"); eq("tok dollar", tt[7], "str:$$a;b$$"); eq("tok E", tt[9], "str:E'a\\'b'");
    eq("tok bcom", tt[10], "bcom:/* c1 */"); eq("tok com", tt[13], "com:-- tail");
    var samples = [SAMPLE, tricky, "select a from t union all select b from u order by 1", "WITH x AS (SELECT 1) SELECT * FROM x;\n\nDELETE FROM t WHERE a = 1;",
      "insert into t (a) values (1) on conflict (a) do update set a = excluded.a returning *", "select a -- one\n, b /* two */ from t", "select x from t where a is distinct from b for update"];
    samples.forEach(function (s, k) {
      [{}, { commas: "leading", indent: "tab" }, { kwcase: "preserve" }].forEach(function (o, j) {
        var once = F(s, o), twice = F(once, o);
        eq("idempotent " + k + "." + j, twice, once);
        eq("tokens kept " + k + "." + j, sig(tokenize(once)), sig(tokenize(s)));
      });
      eq("minify stable " + k, minify(F(s, { kwcase: "preserve" }), true), minify(s, true));
      eq("minify tokens " + k, sig(tokenize(minify(s, false))), sig(tokenize(s)));
    });
    eq("minify", minify("select a , b\nfrom t -- c\nwhere x = - 1;", false), "SELECT a,b FROM t WHERE x=-1;".replace("SELECT", "select").replace("FROM", "from").replace("WHERE", "where"));
    eq("minify keeps --", minify("select 1 - -1", false), "select 1- -1");
    return fails.length ? fails : true;
  };

  input.value = S3.store("sql.last") || "";
  input.addEventListener("input", S3.debounce(function () { S3.store("sql.last", input.value.length < 100000 ? input.value : undefined); }, 500));
  render();
})();
