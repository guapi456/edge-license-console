(() => {
  "use strict";

  const TOKEN_KEY = "edge_license_admin_session";
  const state = {
    token: sessionStorage.getItem(TOKEN_KEY) || "",
    route: "overview",
    projects: [],
    plans: [],
    licenses: [],
    audit: [],
    stats: {},
    page: 1,
    pageSize: 20,
    licenseTotal: 0,
    licenseNextCursor: null,
    licenseCursors: [null],
    selectedLicenseIds: new Set(),
    generatedKeys: [],
    confirmAction: null,
    loaded: new Set(),
  };

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const escapeHtml = (value) => String(value ?? "").replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[char]));
  const formatNumber = (value) => new Intl.NumberFormat("zh-CN").format(Number(value || 0));
  const formatDate = (value) => {
    if (!value) return "-";
    const raw = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
    const date = typeof raw === "number" && raw < 100000000000 ? new Date(raw * 1000) : new Date(raw);
    return Number.isNaN(date.getTime()) ? "-" : new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(date);
  };
  const itemList = (payload, keys) => {
    if (Array.isArray(payload)) return payload;
    for (const key of keys) if (Array.isArray(payload?.[key])) return payload[key];
    return [];
  };

  function toast(message, type = "success") {
    const el = document.createElement("div");
    el.className = `toast ${type}`;
    el.textContent = message;
    $("#toast-region").append(el);
    setTimeout(() => el.remove(), 4200);
  }

  function stateView(kind, title, detail = "") {
    const spinner = kind === "loading" ? '<span class="spinner" aria-hidden="true"></span>' : "";
    return `<div class="state">${spinner}<div><strong>${escapeHtml(title)}</strong>${detail ? `<span>${escapeHtml(detail)}</span>` : ""}</div></div>`;
  }

  async function api(path, options = {}) {
    const headers = new Headers(options.headers || {});
    headers.set("Authorization", `Bearer ${state.token}`);
    if (options.body && !(options.body instanceof FormData)) headers.set("Content-Type", "application/json");
    const response = await fetch(path, { ...options, headers });
    const contentType = response.headers.get("content-type") || "";
    const data = contentType.includes("application/json") ? await response.json() : await response.text();
    if (response.status === 401) {
      logout("管理令牌已失效，请重新登录。");
      throw new Error("令牌已失效");
    }
    if (!response.ok) {
      const message = data?.error?.message || data?.error || data?.message || `请求失败（${response.status}）`;
      throw new Error(typeof message === "string" ? message : JSON.stringify(message));
    }
    return data;
  }

  async function createSession(username, password) {
    const response = await fetch("/api/admin/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(response.status === 429 ? "登录尝试过多，请稍后再试" : "账号或密码错误");
    return data.token;
  }

  async function apiCompatible(primary, fallback, options = {}) {
    try { return await api(primary, options); }
    catch (error) {
      const message = String(error.message);
      if (!message.includes("not_found") && !message.includes("（404）")) throw error;
      return api(fallback, options);
    }
  }

  function login(token) {
    state.token = token.trim();
    sessionStorage.setItem(TOKEN_KEY, state.token);
    $("#login-form").reset();
    $("#login-view").hidden = true;
    $("#app-view").hidden = false;
    navigate(location.hash.slice(1) || "overview", true);
  }

  function logout(message = "") {
    state.token = "";
    state.loaded.clear();
    state.generatedKeys = [];
    sessionStorage.removeItem(TOKEN_KEY);
    $("#app-view").hidden = true;
    $("#login-view").hidden = false;
    $("#login-form").reset();
    if (message) {
      $("#login-error").textContent = message;
      $("#login-error").hidden = false;
    }
    setTimeout(() => $("#username-input").focus(), 0);
  }

  async function navigate(route, force = false) {
    if (!['overview', 'projects', 'plans', 'licenses', 'audit'].includes(route)) route = "overview";
    state.route = route;
    $$("[data-page]").forEach((page) => { page.hidden = page.dataset.page !== route; });
    $$("[data-route]").forEach((link) => link.classList.toggle("active", link.dataset.route === route));
    if (location.hash !== `#${route}`) history.replaceState(null, "", `#${route}`);
    $("#main-content").focus({ preventScroll: true });
    await loadRoute(route, force);
  }

  async function loadRoute(route, force = false) {
    if (!force && state.loaded.has(route)) return;
    try {
      if (route === "overview") await Promise.all([loadStats(), loadProjects(), loadAudit()]);
      if (route === "projects") await loadProjects();
      if (route === "plans") await Promise.all([loadProjects(), loadPlans()]);
      if (route === "licenses") {
        await Promise.all([loadProjects(), loadPlans()]);
        await loadLicenses();
      }
      if (route === "audit") await loadAudit();
      state.loaded.add(route);
    } catch (error) {
      if (state.token) toast(error.message, "error");
    }
  }

  async function loadStats() {
    $("#stats-grid").innerHTML = stateView("loading", "正在加载统计");
    try {
      try {
        const data = await api("/api/admin/stats");
        state.stats = data?.stats || data || {};
      } catch (error) {
        if (!String(error.message).includes("not_found")) throw error;
        const [projectsData, licensesData] = await Promise.all([
          api("/api/admin/projects"),
          api("/api/admin/licenses?limit=100"),
        ]);
        const projects = itemList(projectsData, ["projects", "items", "data"]);
        const licenses = itemList(licensesData, ["licenses", "items", "data"]);
        state.stats = {
          projects: projects.length,
          total_licenses: projects.reduce((sum, project) => sum + Number(project.license_count || 0), 0),
          active_licenses: licenses.filter((license) => ["active", "enabled"].includes(license.status)).length,
          bound_devices: licenses.reduce((sum, license) => sum + Number(license.active_devices || 0), 0),
        };
      }
      renderStats();
    } catch (error) {
      $("#stats-grid").innerHTML = stateView("error", "统计加载失败", error.message);
      throw error;
    }
  }

  function renderStats() {
    const s = state.stats;
    const metrics = [
      ["项目", s.projects ?? s.project_count, "已配置项目"],
      ["有效授权", s.active_licenses ?? s.active, "当前可用"],
      ["授权总数", s.total_licenses ?? s.licenses, "累计生成"],
      ["绑定设备", s.bound_devices ?? s.devices, "当前绑定"],
    ];
    $("#stats-grid").innerHTML = metrics.map(([label, value, note]) => `<div class="stat"><span>${label}</span><strong>${formatNumber(value)}</strong><small>${note}</small></div>`).join("");
    $("#stats-grid").setAttribute("aria-busy", "false");
  }

  async function loadProjects() {
    ["#projects-table", "#overview-projects"].forEach((id) => { if ($(id)) $(id).innerHTML = stateView("loading", "正在加载项目"); });
    try {
      const data = await api("/api/admin/projects");
      state.projects = itemList(data, ["projects", "items", "data"]);
      renderProjects();
      syncProjectSelects();
    } catch (error) {
      ["#projects-table", "#overview-projects"].forEach((id) => { if ($(id)) $(id).innerHTML = stateView("error", "项目加载失败", error.message); });
      throw error;
    }
  }

  function renderProjects() {
    const rows = state.projects.map((project) => `<tr><td><strong>${escapeHtml(project.name)}</strong><span class="muted truncate">${escapeHtml(project.description || project.slug || "-")}</span></td><td><div class="uuid-cell"><code class="mono">${escapeHtml(project.id)}</code><button class="button quiet small" data-action="copy-project-id" data-id="${escapeHtml(project.id)}" type="button">复制 UUID</button></div></td><td class="mono">${escapeHtml(project.slug || "-")}</td><td>${formatNumber(project.license_count)}</td><td><span class="status ${escapeHtml(project.status || (project.enabled === false ? "disabled" : "active"))}">${statusLabel(project.status || (project.enabled === false ? "disabled" : "active"))}</span></td><td>${formatDate(project.created_at)}</td><td><div class="actions project-actions"><button class="button danger small" data-action="delete-project" data-id="${escapeHtml(project.id)}" type="button">删除</button></div></td></tr>`).join("");
    $("#projects-table").innerHTML = rows ? `<div class="table-wrap"><table><thead><tr><th>项目</th><th>项目 UUID</th><th>Slug</th><th>卡密数量</th><th>状态</th><th>创建时间</th><th class="actions">操作</th></tr></thead><tbody>${rows}</tbody></table></div>` : stateView("empty", "还没有项目", "新建项目后可配置套餐并生成授权码。");
    const recent = state.projects.slice(0, 5).map((project) => `<tr><td><strong>${escapeHtml(project.name)}</strong></td><td><span class="status ${escapeHtml(project.status || "active")}">${statusLabel(project.status || "active")}</span></td><td class="mono">${escapeHtml(project.slug || project.id)}</td></tr>`).join("");
    $("#overview-projects").innerHTML = recent ? `<div class="table-wrap"><table><thead><tr><th>项目</th><th>状态</th><th>标识</th></tr></thead><tbody>${recent}</tbody></table></div>` : stateView("empty", "还没有项目");
  }

  async function loadPlans() {
    $("#plans-table").innerHTML = stateView("loading", "正在加载套餐");
    try {
      const data = await api("/api/admin/plans");
      state.plans = itemList(data, ["plans", "items", "data"]);
      renderPlans();
      syncBulkPlans();
    } catch (error) {
      $("#plans-table").innerHTML = stateView("error", "套餐加载失败", error.message);
      throw error;
    }
  }

  function renderPlans() {
    const rows = state.plans.map((plan) => `<tr><td><strong>${escapeHtml(plan.name)}</strong></td><td>${escapeHtml(projectName(plan.project_id))}</td><td>${escapeHtml(kindLabel(plan.kind || plan.type || plan.preset))}</td><td>${formatNumber(plan.duration_days ?? plan.days ?? Math.round(Number(plan.duration_seconds || 0) / 86400))} 天</td><td>${formatNumber(plan.max_devices ?? 1)}</td><td>${formatDate(plan.created_at)}</td></tr>`).join("");
    $("#plans-table").innerHTML = rows ? `<div class="table-wrap"><table><thead><tr><th>套餐</th><th>项目</th><th>周期</th><th>有效期</th><th>设备上限</th><th>创建时间</th></tr></thead><tbody>${rows}</tbody></table></div>` : stateView("empty", "还没有套餐", "先创建套餐，再批量签发授权码。");
  }

  async function loadLicenses() {
    $("#licenses-table").innerHTML = stateView("loading", "正在加载授权码");
    $("#license-pagination").hidden = true;
    const params = new URLSearchParams({ page: state.page, page_size: state.pageSize, limit: state.pageSize });
    const cursor = state.licenseCursors[state.page - 1];
    if (cursor) params.set("cursor", cursor);
    const form = new FormData($("#license-filters"));
    for (const [key, value] of form.entries()) if (String(value).trim()) params.set(key, String(value).trim());
    try {
      const data = await api(`/api/admin/licenses?${params}`);
      state.licenses = itemList(data, ["licenses", "items", "data"]);
      state.selectedLicenseIds.clear();
      state.licenseTotal = Number(data?.total ?? data?.pagination?.total ?? state.licenses.length);
      state.licenseNextCursor = data?.next_cursor || data?.pagination?.next_cursor || null;
      renderLicenses();
    } catch (error) {
      $("#licenses-table").innerHTML = stateView("error", "授权码加载失败", error.message);
      throw error;
    }
  }

  function renderLicenses() {
    const rows = state.licenses.map((license) => {
      const status = license.status || (license.disabled ? "disabled" : "active");
      const devices = license.device_count ?? license.active_devices ?? license.bound_devices?.length ?? license.devices?.length ?? 0;
      const displayKey = license.key || license.code || license.display_hint || license.id;
      const copyControl = license.key
        ? `<button class="button quiet small" data-action="copy-key" data-id="${escapeHtml(license.id)}" type="button">复制</button>`
        : '<span class="key-unavailable">历史卡密仅显示尾号</span>';
      return `<tr><td class="select-cell"><input class="row-check" type="checkbox" data-license-select="${escapeHtml(license.id)}" aria-label="选择授权码 ${escapeHtml(displayKey)}"></td><td><div class="key-cell"><code class="license-key">${escapeHtml(displayKey)}</code>${copyControl}</div></td><td>${escapeHtml(projectName(license.project_id))}</td><td>${escapeHtml(license.plan_name || planName(license.plan_id))}</td><td><span class="status ${escapeHtml(status)}">${statusLabel(status)}</span></td><td>${formatNumber(devices)} / ${formatNumber(license.max_devices ?? 1)}</td><td>${formatDate(license.expires_at)}</td><td><div class="actions license-actions"><button class="button quiet small" data-action="reset" data-id="${escapeHtml(license.id)}">解绑设备</button><button class="button ${status === "disabled" ? "secondary" : "danger"} small" data-action="toggle" data-id="${escapeHtml(license.id)}" data-disabled="${status === "disabled"}">${status === "disabled" ? "启用" : "停用"}</button><button class="button danger small" data-action="delete-license" data-id="${escapeHtml(license.id)}">删除</button></div></td></tr>`;
    }).join("");
    $("#licenses-table").innerHTML = rows ? `<div class="table-wrap"><table><thead><tr><th class="select-cell"><input id="select-page-licenses" type="checkbox" aria-label="选择本页全部授权码"></th><th>授权码</th><th>项目</th><th>套餐</th><th>状态</th><th>设备</th><th>到期时间</th><th class="actions">操作</th></tr></thead><tbody>${rows}</tbody></table></div>` : stateView("empty", "没有匹配的授权码", "调整筛选条件或批量生成新授权码。");
    const hasTotal = state.licenseTotal > state.licenses.length || (state.page === 1 && !state.licenseNextCursor);
    const pages = hasTotal ? Math.max(1, Math.ceil(state.licenseTotal / state.pageSize)) : null;
    $("#pagination-summary").textContent = hasTotal ? `共 ${formatNumber(state.licenseTotal)} 条` : `本页 ${formatNumber(state.licenses.length)} 条`;
    $("#page-number").textContent = pages ? `${state.page} / ${pages}` : `第 ${state.page} 页`;
    $("#prev-page").disabled = state.page <= 1;
    $("#next-page").disabled = state.licenseNextCursor ? false : pages ? state.page >= pages : true;
    $("#license-pagination").hidden = state.licenses.length === 0;
    $("#copy-visible-keys").disabled = !state.licenses.some((license) => license.key);
    syncLicenseSelection();
  }

  function syncLicenseSelection() {
    const selectedCount = state.selectedLicenseIds.size;
    const button = $("#delete-selected-licenses");
    button.disabled = selectedCount === 0;
    button.textContent = selectedCount ? `批量删除 (${selectedCount})` : "批量删除";
    const selectPage = $("#select-page-licenses");
    if (selectPage) {
      selectPage.checked = state.licenses.length > 0 && selectedCount === state.licenses.length;
      selectPage.indeterminate = selectedCount > 0 && selectedCount < state.licenses.length;
    }
  }

  async function loadAudit() {
    ["#audit-table", "#overview-audit"].forEach((id) => { if ($(id)) $(id).innerHTML = stateView("loading", "正在加载审计日志"); });
    try {
      const data = await api("/api/admin/audit");
      state.audit = itemList(data, ["audit", "logs", "items", "data"]);
      renderAudit();
    } catch (error) {
      ["#audit-table", "#overview-audit"].forEach((id) => { if ($(id)) $(id).innerHTML = stateView("error", "审计日志加载失败", error.message); });
      throw error;
    }
  }

  function renderAudit() {
    const makeRows = (items) => items.map((entry) => {
      const targetId = entry.target_id || entry.resource_id || entry.license_id || entry.project_id || "-";
      const targetType = entry.target_type || entry.resource || (entry.license_id ? "license" : entry.project_id ? "project" : "-");
      return `<tr><td>${formatDate(entry.created_at || entry.timestamp)}</td><td><strong>${escapeHtml(entry.action || entry.event || entry.event_type || "-")}</strong></td><td>${escapeHtml(targetType)}</td><td class="mono"><span class="truncate">${escapeHtml(targetId)}</span></td><td>${escapeHtml(entry.actor || entry.ip || entry.source_ip || "-")}</td></tr>`;
    }).join("");
    const allRows = makeRows(state.audit);
    const header = `<thead><tr><th>时间</th><th>动作</th><th>对象</th><th>对象 ID</th><th>来源</th></tr></thead>`;
    $("#audit-table").innerHTML = allRows ? `<div class="table-wrap"><table>${header}<tbody>${allRows}</tbody></table></div>` : stateView("empty", "暂无审计日志");
    const recentRows = makeRows(state.audit.slice(0, 5));
    $("#overview-audit").innerHTML = recentRows ? `<div class="table-wrap"><table>${header}<tbody>${recentRows}</tbody></table></div>` : stateView("empty", "暂无审计日志");
  }

  function statusLabel(status) {
    return ({ active: "有效", enabled: "已启用", valid: "有效", disabled: "已停用", revoked: "已吊销", expired: "已过期", unused: "未激活", pending: "待处理" })[status] || status || "未知";
  }
  function kindLabel(kind) { return ({ daily: "日卡", weekly: "周卡", monthly: "月卡", quarterly: "季卡", annual: "年卡", custom: "自定义", trial_7d: "7 日试用" })[kind] || kind || "自定义"; }
  function projectName(id) { return state.projects.find((item) => String(item.id) === String(id))?.name || id || "-"; }
  function planName(id) { return state.plans.find((item) => String(item.id) === String(id))?.name || id || "-"; }
  async function copyText(value, successMessage) {
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      const input = document.createElement("textarea");
      input.value = value;
      input.style.position = "fixed";
      input.style.opacity = "0";
      document.body.append(input);
      input.select();
      document.execCommand("copy");
      input.remove();
    }
    toast(successMessage);
  }

  function syncProjectSelects() {
    const options = state.projects.map((project) => `<option value="${escapeHtml(project.id)}">${escapeHtml(project.name)}</option>`).join("");
    $$('[data-project-select]').forEach((select) => {
      const selected = select.value;
      select.innerHTML = `<option value="">选择项目</option>${options}`;
      select.value = selected;
    });
    const filter = $("#filter-project");
    const selected = filter.value;
    filter.innerHTML = `<option value="">全部项目</option>${options}`;
    filter.value = selected;
  }

  function syncBulkPlans() {
    const projectId = $("#bulk-project").value;
    const plans = projectId ? state.plans.filter((plan) => String(plan.project_id) === String(projectId)) : [];
    $("#bulk-plan").innerHTML = `<option value="">${projectId ? "选择套餐" : "先选择项目"}</option>${plans.map((plan) => `<option value="${escapeHtml(plan.id)}">${escapeHtml(plan.name)}</option>`).join("")}`;
  }

  function setBusy(form, busy, text) {
    const button = form.querySelector('button[type="submit"]');
    if (!button) return;
    if (!button.dataset.label) button.dataset.label = button.textContent;
    button.disabled = busy;
    button.textContent = busy ? text : button.dataset.label;
  }

  function payloadFrom(form) {
    const payload = Object.fromEntries(new FormData(form));
    for (const key of ["count", "duration_days", "max_devices"]) if (key in payload) payload[key] = Number(payload[key]);
    for (const checkbox of form.querySelectorAll('input[type="checkbox"][name]')) payload[checkbox.name] = checkbox.checked;
    return payload;
  }

  async function ensurePlans() {
    if (state.plans.length) return;
    await loadPlans();
  }

  function showConfirm({ title, message, label = "确认", danger = true, action }) {
    state.confirmAction = action;
    $("#confirm-title").textContent = title;
    $("#confirm-message").textContent = message;
    $("#confirm-submit").textContent = label;
    $("#confirm-submit").className = `button ${danger ? "danger" : "primary"}`;
    $("#confirm-modal").showModal();
  }

  function normalizeGeneratedKeys(data) {
    const rows = itemList(data, ["licenses", "keys", "items", "data"]);
    return rows.map((item) => typeof item === "string" ? { key: item } : item).filter((item) => item.key || item.code);
  }

  function showGeneratedKeys(keys) {
    state.generatedKeys = keys;
    $("#keys-count").textContent = `共 ${formatNumber(keys.length)} 个授权码`;
    $("#keys-output").value = keys.map((item) => item.key || item.code).join("\n");
    $("#keys-modal").showModal();
  }

  function clearGeneratedKeys() {
    state.generatedKeys = [];
    $("#keys-output").value = "";
    $("#keys-modal").close();
  }

  function csvValue(value) { return `"${String(value ?? "").replace(/"/g, '""')}"`; }
  function downloadKeys() {
    if (!state.generatedKeys.length) return;
    const lines = ["license_key,project_id,plan_id,expires_at,max_devices", ...state.generatedKeys.map((item) => [item.key || item.code, item.project_id || "", item.plan_id || "", item.expires_at || "", item.max_devices || ""].map(csvValue).join(","))];
    const blob = new Blob(["\ufeff" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `licenses-${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    URL.revokeObjectURL(url);
    toast("CSV 已下载");
  }

  function bindEvents() {
    window.addEventListener("hashchange", () => state.token && navigate(location.hash.slice(1)));
    $("#login-form").addEventListener("submit", async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      const data = new FormData(form);
      const username = String(data.get("username") || "").trim();
      const password = String(data.get("password") || "");
      $("#login-error").hidden = true;
      setBusy(form, true, "正在验证...");
      try {
        const token = await createSession(username, password);
        login(token);
      } catch (error) {
        state.token = "";
        $("#login-error").textContent = error.message;
        $("#login-error").hidden = false;
      } finally { setBusy(form, false); }
    });
    $("#logout-button").addEventListener("click", () => logout());
    $("#refresh-button").addEventListener("click", async () => { state.loaded.delete(state.route); await loadRoute(state.route, true); toast("数据已刷新"); });

    $$('[data-open]').forEach((button) => button.addEventListener("click", async () => {
      const id = button.dataset.open;
      try {
        if (id === "bulk-modal") { await Promise.all([loadProjects(), ensurePlans()]); syncBulkPlans(); }
        if (id === "plan-modal") await loadProjects();
        $(`#${id}`).showModal();
      } catch (error) { toast(error.message, "error"); }
    }));

    $$('[data-close]').forEach((button) => button.addEventListener("click", () => {
      const dialog = button.closest("dialog");
      if (dialog.id === "confirm-modal") state.confirmAction = null;
      dialog.close();
    }));

    $("#project-form").addEventListener("submit", async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      setBusy(form, true, "正在创建...");
      try {
        await api("/api/admin/projects", { method: "POST", body: JSON.stringify(payloadFrom(form)) });
        form.closest("dialog").close(); form.reset(); state.loaded.clear(); await loadProjects(); toast("项目已创建");
      } catch (error) { toast(error.message, "error"); } finally { setBusy(form, false); }
    });

    $("#projects-table").addEventListener("click", async (event) => {
      const button = event.target.closest("button[data-action]");
      if (!button) return;
      const id = button.dataset.id;
      const project = state.projects.find((item) => String(item.id) === id);
      if (!project) return;
      if (button.dataset.action === "copy-project-id") {
        await copyText(project.id, "项目 UUID 已复制");
        return;
      }
      if (button.dataset.action === "delete-project") {
        showConfirm({
          title: `删除项目“${project.name}”`,
          message: `将永久删除该项目、${formatNumber(project.plan_count || 0)} 个套餐、${formatNumber(project.license_count || 0)} 张卡密及全部设备和会话。项目 UUID：${project.id}`,
          label: "永久删除",
          action: async () => {
            await api(`/api/admin/projects/${encodeURIComponent(id)}`, { method: "DELETE" });
            return { refresh: "projects" };
          },
        });
      }
    });

    $("#plan-kind").addEventListener("change", (event) => {
      const days = { daily: 1, weekly: 7, monthly: 30, quarterly: 90, annual: 365 }[event.target.value];
      if (days) $("#duration-days").value = days;
      $("#duration-days").readOnly = event.target.value !== "custom";
    });

    $("#plan-form").addEventListener("submit", async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      setBusy(form, true, "正在创建...");
      try {
        const payload = payloadFrom(form);
        payload.duration_seconds = payload.duration_days * 86400;
        const preset = { daily: "daily", weekly: "weekly", monthly: "monthly", quarterly: "quarterly", annual: "annual" }[payload.kind];
        if (preset) payload.preset = preset;
        delete payload.duration_days;
        await api("/api/admin/plans", { method: "POST", body: JSON.stringify(payload) });
        form.closest("dialog").close(); form.reset(); state.loaded.delete("plans"); await loadPlans(); toast("套餐已创建");
      } catch (error) { toast(error.message, "error"); } finally { setBusy(form, false); }
    });

    $("#bulk-project").addEventListener("change", syncBulkPlans);
    $("#bulk-form").addEventListener("submit", async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      setBusy(form, true, "正在生成...");
      try {
        const request = { method: "POST", body: JSON.stringify(payloadFrom(form)) };
        const data = await apiCompatible("/api/admin/licenses/bulk", "/api/admin/licenses/batch", request);
        const submitted = payloadFrom(form);
        const keys = normalizeGeneratedKeys(data).map((item) => ({
          ...item,
          project_id: submitted.project_id,
          plan_id: submitted.plan_id,
          max_devices: submitted.max_devices,
        }));
        if (!keys.length) throw new Error("接口未返回可显示的授权码");
        form.closest("dialog").close(); showGeneratedKeys(keys); state.loaded.delete("licenses"); state.loaded.delete("overview");
      } catch (error) { toast(error.message, "error"); } finally { setBusy(form, false); }
    });

    $("#license-filters").addEventListener("submit", async (event) => { event.preventDefault(); state.page = 1; state.licenseCursors = [null]; await loadLicenses(); });
    $("#clear-filters").addEventListener("click", async () => { $("#license-filters").reset(); state.page = 1; state.licenseCursors = [null]; await loadLicenses(); });
    $("#prev-page").addEventListener("click", async () => { if (state.page > 1) { state.page--; state.licenseCursors.length = state.page; await loadLicenses(); } });
    $("#next-page").addEventListener("click", async () => {
      if (state.licenseNextCursor) state.licenseCursors[state.page] = state.licenseNextCursor;
      state.page++;
      await loadLicenses();
    });
    $("#copy-visible-keys").addEventListener("click", async () => {
      const keys = state.licenses.map((license) => license.key).filter(Boolean);
      if (keys.length) await copyText(keys.join("\n"), `已复制本页 ${keys.length} 个授权码`);
    });
    $("#delete-selected-licenses").addEventListener("click", () => {
      const ids = [...state.selectedLicenseIds];
      if (!ids.length) return;
      showConfirm({
        title: `批量删除 ${ids.length} 张授权码`,
        message: "将永久删除选中授权码及其设备绑定、会话和激活记录。此操作不可撤销。",
        label: "永久删除",
        action: async () => {
          await api("/api/admin/licenses/delete-batch", { method: "POST", body: JSON.stringify({ ids }) });
          state.selectedLicenseIds.clear();
          return { refresh: "licenses", message: `已删除 ${ids.length} 张授权码` };
        },
      });
    });
    $("#licenses-table").addEventListener("change", (event) => {
      const checkbox = event.target;
      if (checkbox.id === "select-page-licenses") {
        state.selectedLicenseIds.clear();
        if (checkbox.checked) state.licenses.forEach((license) => state.selectedLicenseIds.add(String(license.id)));
      } else if (checkbox.matches("[data-license-select]")) {
        if (checkbox.checked) state.selectedLicenseIds.add(checkbox.dataset.licenseSelect);
        else state.selectedLicenseIds.delete(checkbox.dataset.licenseSelect);
      } else return;
      syncLicenseSelection();
    });
    $("#licenses-table").addEventListener("click", async (event) => {
      const button = event.target.closest("button[data-action]");
      if (!button) return;
      const id = button.dataset.id;
      if (button.dataset.action === "copy-key") {
        const license = state.licenses.find((item) => String(item.id) === id);
        if (license?.key) await copyText(license.key, "授权码已复制");
        return;
      }
      if (button.dataset.action === "reset") showConfirm({ title: "解绑全部设备", message: "该授权码下次使用时需要重新绑定设备。此操作会写入审计日志。", label: "确认解绑", action: () => api(`/api/admin/licenses/${encodeURIComponent(id)}/reset-devices`, { method: "POST" }) });
      if (button.dataset.action === "delete-license") {
        const license = state.licenses.find((item) => String(item.id) === id);
        showConfirm({
          title: "删除授权码",
          message: `将永久删除授权码 ${license?.key || license?.display_hint || id} 及其设备绑定、会话和激活记录。`,
          label: "永久删除",
          action: async () => {
            await api(`/api/admin/licenses/${encodeURIComponent(id)}`, { method: "DELETE" });
            state.selectedLicenseIds.delete(id);
            return { refresh: "licenses", message: "授权码已删除" };
          },
        });
      }
      if (button.dataset.action === "toggle") {
        const disabled = button.dataset.disabled === "true";
        const nextStatus = disabled ? "enabled" : "disabled";
        showConfirm({
          title: disabled ? "启用授权码" : "停用授权码",
          message: disabled ? "启用后，该授权码可按原有效期继续使用。" : "停用后，客户端校验将立即失败。",
          label: disabled ? "确认启用" : "确认停用",
          danger: !disabled,
          action: async () => {
            try {
              return await api(`/api/admin/licenses/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify({ status: nextStatus, disabled: !disabled }) });
            } catch (error) {
              if (!String(error.message).includes("not_found") && !String(error.message).includes("（404）")) throw error;
              return api(`/api/admin/licenses/${encodeURIComponent(id)}/${nextStatus === "enabled" ? "enable" : "disable"}`, { method: "POST" });
            }
          },
        });
      }
    });

    $("#confirm-form").addEventListener("submit", async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      if (!state.confirmAction) return;
      setBusy(form, true, "处理中...");
      try {
        const result = await state.confirmAction();
        $("#confirm-modal").close(); state.confirmAction = null;
        if (result?.refresh === "projects") {
          state.loaded.clear();
          await loadProjects();
          toast("项目已删除");
        } else {
          state.loaded.delete("overview");
          await loadLicenses();
          toast(result?.message || "操作已完成");
        }
      } catch (error) { toast(error.message, "error"); } finally { setBusy(form, false); }
    });

    $("#copy-keys").addEventListener("click", async () => {
      await copyText($("#keys-output").value, "授权码已复制");
    });
    $("#download-keys").addEventListener("click", downloadKeys);
    $("#close-keys").addEventListener("click", clearGeneratedKeys);
    $("#keys-modal").addEventListener("cancel", (event) => { event.preventDefault(); clearGeneratedKeys(); });
    $("#keys-modal").addEventListener("close", () => { state.generatedKeys = []; $("#keys-output").value = ""; });
  }

  function init() {
    bindEvents();
    $("#duration-days").readOnly = true;
    if (state.token) {
      $("#login-view").hidden = true;
      $("#app-view").hidden = false;
      navigate(location.hash.slice(1) || "overview", true);
    }
  }

  init();
})();
