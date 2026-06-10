/**
 * Reusable supplier filter component.
 * Supports: All Suppliers (default), single, or multiple selection.
 */
function createSupplierFilter(containerEl, options = {}) {
  const { onChange, label = "Supplier:" } = options;
  let suppliers = [];
  let selectedIds = new Set();

  containerEl.classList.add("supplier-filter");
  containerEl.innerHTML = `
    <label class="supplier-filter-label">${label}</label>
    <div class="supplier-filter-control">
      <button type="button" class="supplier-filter-toggle menu-btn">All Suppliers</button>
      <div class="supplier-filter-dropdown hidden">
        <label class="supplier-filter-all">
          <input type="checkbox" data-supplier-all checked />
          All Suppliers
        </label>
        <div class="supplier-filter-list"></div>
      </div>
    </div>
  `;

  const toggleBtn = containerEl.querySelector(".supplier-filter-toggle");
  const dropdown = containerEl.querySelector(".supplier-filter-dropdown");
  const allCheckbox = containerEl.querySelector("[data-supplier-all]");
  const listEl = containerEl.querySelector(".supplier-filter-list");

  function updateToggleLabel() {
    if (selectedIds.size === 0) {
      toggleBtn.textContent = "All Suppliers";
      return;
    }
    if (selectedIds.size === 1) {
      const id = Array.from(selectedIds)[0];
      const s = suppliers.find((x) => x.id === id);
      toggleBtn.textContent = s ? s.name : "1 supplier";
      return;
    }
    toggleBtn.textContent = `${selectedIds.size} suppliers`;
  }

  function emitChange() {
    const ids = selectedIds.size > 0 ? Array.from(selectedIds) : null;
    if (typeof onChange === "function") onChange(ids);
  }

  function renderList() {
    listEl.innerHTML = suppliers
      .map(
        (s) => `
      <label class="supplier-filter-item">
        <input type="checkbox" data-supplier-id="${s.id}" ${selectedIds.has(s.id) ? "checked" : ""} />
        ${escapeHtml(s.name)}
      </label>
    `
      )
      .join("");

    listEl.querySelectorAll("[data-supplier-id]").forEach((chk) => {
      chk.addEventListener("change", () => {
        const id = Number(chk.getAttribute("data-supplier-id"));
        if (chk.checked) {
          selectedIds.add(id);
          allCheckbox.checked = false;
        } else {
          selectedIds.delete(id);
          if (selectedIds.size === 0) allCheckbox.checked = true;
        }
        updateToggleLabel();
        emitChange();
      });
    });
  }

  allCheckbox.addEventListener("change", () => {
    if (allCheckbox.checked) {
      selectedIds.clear();
      listEl.querySelectorAll("[data-supplier-id]").forEach((chk) => {
        chk.checked = false;
      });
      updateToggleLabel();
      emitChange();
    } else if (selectedIds.size === 0) {
      allCheckbox.checked = true;
    }
  });

  toggleBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    dropdown.classList.toggle("hidden");
  });

  document.addEventListener("click", (e) => {
    if (!containerEl.contains(e.target)) {
      dropdown.classList.add("hidden");
    }
  });

  async function loadSuppliers() {
    if (!window.api?.suppliersGetAll) return;
    suppliers = await window.api.suppliersGetAll();
    renderList();
    updateToggleLabel();
  }

  function getSelectedIds() {
    return selectedIds.size > 0 ? Array.from(selectedIds) : null;
  }

  function setSelectedIds(ids) {
    selectedIds = new Set((ids || []).map(Number).filter((id) => id > 0));
    allCheckbox.checked = selectedIds.size === 0;
    renderList();
    updateToggleLabel();
  }

  loadSuppliers();

  return {
    reload: loadSuppliers,
    getSelectedIds,
    setSelectedIds,
  };
}

function escapeHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
