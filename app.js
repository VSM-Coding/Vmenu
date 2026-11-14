window.onerror = function(msg, url, line) {
    const banner = document.getElementById('error-banner');
    if (banner) {
        banner.style.display = 'block';
        banner.innerText = 'Ошибка в коде (строка ' + line + '): ' + msg;
    }
};

const baseDefaultRecipes = (typeof defaultRecipes !== 'undefined' && Array.isArray(defaultRecipes))
    ? defaultRecipes
    : [];

// Список ID базовых рецептов, которые пользователь осознанно удалил
let deletedDefaultIds = [];
try {
    const savedDeleted = JSON.parse(localStorage.getItem('deleted_default_ids'));
    if (Array.isArray(savedDeleted)) deletedDefaultIds = savedDeleted.map(String);
} catch (e) {}

let recipes = [];

try {
    const saved = JSON.parse(localStorage.getItem('my_recipes'));

    if (Array.isArray(saved) && saved.length > 0) {
        recipes = saved.map(r => ({
            id: String(r.id || Date.now()),
            name: r.name || 'Без названия',
            category: r.category || 'Обед',
            servings: Number(r.servings) || 2,
            ingredients: Array.isArray(r.ingredients) ? r.ingredients : [],
            steps: Array.isArray(r.steps) ? r.steps : []
        }));

        // Подтягиваем новые рецепты из recipes.js, если их не удаляли вручную
        let merged = false;
        baseDefaultRecipes.forEach(def => {
            const defId = String(def.id);
            if (!recipes.some(r => String(r.id) === defId) && !deletedDefaultIds.includes(defId)) {
                recipes.push(def);
                merged = true;
            }
        });
        if (merged) {
            localStorage.setItem('my_recipes', JSON.stringify(recipes));
        }
    } else {
        recipes = [...baseDefaultRecipes];
        localStorage.setItem('my_recipes', JSON.stringify(recipes));
    }
} catch (e) {
    recipes = [...baseDefaultRecipes];
}

// Избранное (массив ID)
let favoriteIds = [];
try {
    const savedFavs = JSON.parse(localStorage.getItem('favorite_recipes'));
    if (Array.isArray(savedFavs)) favoriteIds = savedFavs.map(String);
} catch (e) {}

// Готовим сегодня: [{ recipeId: "3", servings: 6 }]
let todayMenu = [];
try {
    const savedToday = JSON.parse(localStorage.getItem('today_recipes'));
    if (Array.isArray(savedToday)) {
        todayMenu = savedToday.filter(item => item && item.recipeId);
    }
} catch (e) {}

// Состояние чекбоксов корзины и свои дополнительные продукты
let cartChecked = {};
try {
    const savedChecked = JSON.parse(localStorage.getItem('cart_checked'));
    if (savedChecked && typeof savedChecked === 'object') cartChecked = savedChecked;
} catch (e) {}

let customCartItems = [];
try {
    const savedCustom = JSON.parse(localStorage.getItem('cart_custom_items'));
    if (Array.isArray(savedCustom)) customCartItems = savedCustom;
} catch (e) {}

let activeTimers = {};
let currentCookingRecipe = null;
let currentPortions = 2;
let completedSteps = {};
let activeCategory = 'все';

// Wake Lock (удержание экрана включённым во время готовки)
let wakeLockSentinel = null;
let wakeLockDesired = false;

// Звук таймера
let sharedAudioCtx = null;
let alarmRepeatInterval = null;

function escapeHtml(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function scaleIngredient(ing, baseServings, targetServings) {
    const ratio = targetServings / (baseServings || 2);
    if (ratio === 1) return String(ing);

    return String(ing).replace(
        /(\d+)\s+(\d+)\s*\/\s*(\d+)|(\d+)\s*\/\s*(\d+)|(\d+(?:[.,]\d+)?)(?!\s*%)/g,
        (match, wholeStr, mNumStr, mDenStr, numStr, denStr, decStr) => {
            let val = null;
            if (wholeStr && mNumStr && mDenStr) {
                const den = parseFloat(mDenStr);
                if (!den) return match;
                val = (parseFloat(wholeStr) + parseFloat(mNumStr) / den) * ratio;
            } else if (numStr && denStr) {
                const den = parseFloat(denStr);
                if (!den) return match;
                val = (parseFloat(numStr) / den) * ratio;
            } else if (decStr) {
                val = parseFloat(decStr.replace(',', '.')) * ratio;
            }
            if (val === null || isNaN(val)) return match;

            const rounded = Math.round(val * 100) / 100;
            if (Math.abs(rounded - 0.25) < 0.01) return '1/4';
            if (Math.abs(rounded - 0.5) < 0.01) return '1/2';
            if (Math.abs(rounded - 0.75) < 0.01) return '3/4';
            return String(Math.round(val * 10) / 10).replace('.', ',');
        }
    );
}

function saveState() {
    localStorage.setItem('my_recipes', JSON.stringify(recipes));
    localStorage.setItem('favorite_recipes', JSON.stringify(favoriteIds));
    localStorage.setItem('today_recipes', JSON.stringify(todayMenu));
    localStorage.setItem('cart_checked', JSON.stringify(cartChecked));
    localStorage.setItem('cart_custom_items', JSON.stringify(customCartItems));
    localStorage.setItem('deleted_default_ids', JSON.stringify(deletedDefaultIds));
}

function isFavorite(id) {
    return favoriteIds.includes(String(id));
}

function isInToday(id) {
    return todayMenu.some(item => String(item.recipeId) === String(id));
}

function clearCheckedForRecipe(recipeId) {
    const prefix = `r_${recipeId}_`;
    Object.keys(cartChecked).forEach(k => {
        if (k.startsWith(prefix)) {
            delete cartChecked[k];
        }
    });
}

function toggleFavorite(id) {
    const strId = String(id);
    if (isFavorite(strId)) {
        favoriteIds = favoriteIds.filter(x => x !== strId);
    } else {
        favoriteIds.push(strId);
    }
    saveState();
    renderAll();
}

function toggleToday(id, customServings) {
    const strId = String(id);
    if (isInToday(strId)) {
        todayMenu = todayMenu.filter(item => String(item.recipeId) !== strId);
        clearCheckedForRecipe(strId);
    } else {
        const r = recipes.find(item => String(item.id) === strId);
        if (!r) return;
        todayMenu.push({
            recipeId: strId,
            servings: customServings || r.servings || 2
        });
    }
    saveState();
    renderAll();
}

function updateBadges() {
    const validFavs = favoriteIds.filter(id => recipes.some(r => String(r.id) === String(id)));
    const badgeFav = document.getElementById('badge-fav');
    badgeFav.innerText = validFavs.length;
    badgeFav.classList.toggle('empty', validFavs.length === 0);

    const validToday = todayMenu.filter(item => recipes.some(r => String(r.id) === String(item.recipeId)));
    const badgeToday = document.getElementById('badge-today');
    badgeToday.innerText = validToday.length;
    badgeToday.classList.toggle('empty', validToday.length === 0);

    let unboughtCount = 0;
    validToday.forEach(entry => {
        const r = recipes.find(item => String(item.id) === String(entry.recipeId));
        if (r) {
            r.ingredients.forEach((_, idx) => {
                const key = `r_${r.id}_${idx}`;
                if (!cartChecked[key]) unboughtCount++;
            });
        }
    });
    customCartItems.forEach(item => {
        if (!item.checked) unboughtCount++;
    });

    const badgeCart = document.getElementById('badge-cart');
    badgeCart.innerText = unboughtCount;
    badgeCart.classList.toggle('empty', unboughtCount === 0);
}

// --- Wake Lock (удержание экрана) ---
async function requestWakeLock() {
    if (!('wakeLock' in navigator)) return false;
    try {
        wakeLockSentinel = await navigator.wakeLock.request('screen');
        wakeLockSentinel.addEventListener('release', () => {
            wakeLockSentinel = null;
        });
        return true;
    } catch (e) {
        return false;
    }
}

async function releaseWakeLock() {
    wakeLockDesired = false;
    if (wakeLockSentinel) {
        try {
            await wakeLockSentinel.release();
        } catch (e) {}
        wakeLockSentinel = null;
    }
}

async function toggleWakeLock() {
    if (!('wakeLock' in navigator)) {
        alert('Ваш браузер не поддерживает удержание экрана включённым.');
        return;
    }
    if (wakeLockDesired) {
        await releaseWakeLock();
    } else {
        wakeLockDesired = true;
        await requestWakeLock();
    }
    if (currentCookingRecipe) {
        renderCookingView();
    }
}

// --- Навигация ---
function switchTab(tabId) {
    document.querySelectorAll('.container').forEach(c => c.classList.remove('active'));
    document.querySelectorAll('#main-nav button').forEach(b => b.classList.remove('active'));

    const target = document.getElementById(tabId + '-tab');
    if (target) target.classList.add('active');

    const navBtn = document.querySelector(`#main-nav button[data-tab="${tabId}"]`);
    if (navBtn) navBtn.classList.add('active');

    if (tabId !== 'cook') {
        document.getElementById('nav-cook').style.display = 'none';
        clearAllTimers();
        stopAlarm();
        releaseWakeLock();
    }
}

document.getElementById('main-nav').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-tab]');
    if (btn) switchTab(btn.dataset.tab);
});

// --- Поиск, сортировка и фильтрация ---
document.getElementById('search-input').addEventListener('input', renderRecipes);
document.getElementById('sort-select').addEventListener('change', renderRecipes);

document.getElementById('category-filters').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-cat]');
    if (!btn) return;
    activeCategory = btn.dataset.cat;
    document.querySelectorAll('.cat-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    renderRecipes();
});

function buildRecipeCard(r) {
    const safeId = escapeHtml(r.id);
    const totalTime = r.steps.reduce((sum, s) => sum + (Number(s.time) || 0), 0);
    const fav = isFavorite(r.id);
    const today = isInToday(r.id);

    const card = document.createElement('div');
    card.className = 'recipe-card';
    card.dataset.cookId = r.id;
    card.innerHTML = `
        <div>
            <div class="card-top">
                <span class="badge">${escapeHtml(r.category)}</span>
                <button type="button" class="fav-btn ${fav ? 'is-fav' : ''}" data-fav-id="${safeId}" title="В избранное">
                    ${fav ? '❤️' : '🤍'}
                </button>
            </div>
            <h3>${escapeHtml(r.name)}</h3>
        </div>
        <div>
            <div class="card-meta">
                <span>⏱ ~${totalTime} мин.</span>
                <span>🥗 ${r.ingredients.length} ингред.</span>
                <span>🍽 ${r.servings} порц.</span>
            </div>
            <div class="card-actions">
                <button type="button" class="btn btn-small ${today ? 'btn-success' : 'btn-outline'}" data-today-id="${safeId}">
                    ${today ? '✅ На сегодня' : '+ На сегодня'}
                </button>
                <div class="card-icon-group">
                    <button type="button" class="btn btn-small btn-ghost" data-edit-id="${safeId}" title="Редактировать">✏️</button>
                    <button type="button" class="btn btn-small btn-ghost" data-delete-id="${safeId}" style="color:#fa5252;" title="Удалить">🗑</button>
                </div>
            </div>
        </div>
    `;
    return card;
}

function renderRecipes() {
    const list = document.getElementById('recipe-list');
    const search = document.getElementById('search-input').value.toLowerCase().trim();
    const sortBy = document.getElementById('sort-select').value;
    list.innerHTML = '';

    let filtered = recipes.filter(r => {
        const matchSearch = r.name.toLowerCase().includes(search) ||
            r.ingredients.some(i => i.toLowerCase().includes(search));
        const matchCat = activeCategory === 'все' || r.category === activeCategory;
        return matchSearch && matchCat;
    });

    if (sortBy === 'time') {
        filtered = [...filtered].sort((a, b) => {
            const tA = a.steps.reduce((s, x) => s + (Number(x.time) || 0), 0);
            const tB = b.steps.reduce((s, x) => s + (Number(x.time) || 0), 0);
            return tA - tB;
        });
    } else if (sortBy === 'alpha') {
        filtered = [...filtered].sort((a, b) => {
            const nA = a.name.replace(/^[^\p{L}\p{N}]+/u, '');
            const nB = b.name.replace(/^[^\p{L}\p{N}]+/u, '');
            return nA.localeCompare(nB, 'ru');
        });
    }

    document.getElementById('recipes-stats').innerText =
        `Показано рецептов: ${filtered.length} из ${recipes.length}`;

    if (filtered.length === 0) {
        list.innerHTML = '<div class="empty-state" style="grid-column: 1 / -1;">По вашему запросу рецепты не найдены.</div>';
        return;
    }

    filtered.forEach(r => list.appendChild(buildRecipeCard(r)));
}

function renderFavorites() {
    const list = document.getElementById('favorites-list');
    list.innerHTML = '';

    const favRecipes = recipes.filter(r => isFavorite(r.id));
    if (favRecipes.length === 0) {
        list.innerHTML = `
            <div class="empty-state" style="grid-column: 1 / -1;">
                В избранном пока пусто.<br>
                Нажмите на 🤍 в углу любого рецепта в базе, чтобы сохранить его сюда.
            </div>
        `;
        return;
    }

    favRecipes.forEach(r => list.appendChild(buildRecipeCard(r)));
}

function handleRecipeGridClick(e) {
    const favBtn = e.target.closest('button[data-fav-id]');
    if (favBtn) {
        e.stopPropagation();
        toggleFavorite(favBtn.dataset.favId);
        return;
    }

    const todayBtn = e.target.closest('button[data-today-id]');
    if (todayBtn) {
        e.stopPropagation();
        toggleToday(todayBtn.dataset.todayId);
        return;
    }

    const editBtn = e.target.closest('button[data-edit-id]');
    if (editBtn) {
        e.stopPropagation();
        openEditRecipeModal(editBtn.dataset.editId);
        return;
    }

    const delBtn = e.target.closest('button[data-delete-id]');
    if (delBtn) {
        e.stopPropagation();
        const id = String(delBtn.dataset.deleteId);
        if (confirm('Удалить этот рецепт из базы?')) {
            recipes = recipes.filter(r => String(r.id) !== id);
            favoriteIds = favoriteIds.filter(x => String(x) !== id);
            todayMenu = todayMenu.filter(x => String(x.recipeId) !== id);
            clearCheckedForRecipe(id);

            if (baseDefaultRecipes.some(def => String(def.id) === id) && !deletedDefaultIds.includes(id)) {
                deletedDefaultIds.push(id);
            }

            saveState();
            renderAll();
        }
        return;
    }

    const card = e.target.closest('.recipe-card[data-cook-id]');
    if (card) {
        startCooking(card.dataset.cookId);
    }
}

document.getElementById('recipe-list').addEventListener('click', handleRecipeGridClick);
document.getElementById('favorites-list').addEventListener('click', handleRecipeGridClick);

// --- Готовим сегодня ---
function renderToday() {
    const list = document.getElementById('today-list');
    const validToday = todayMenu.filter(item => recipes.some(r => String(r.id) === String(item.recipeId)));

    if (validToday.length === 0) {
        list.innerHTML = `
            <div class="empty-state">
                На сегодня пока ничего не выбрано.<br>
                Откройте базу рецептов и нажмите <strong>«+ На сегодня»</strong> на нужных блюдах — их продукты сразу появятся в корзине.
            </div>
        `;
        return;
    }

    list.innerHTML = validToday.map(entry => {
        const r = recipes.find(item => String(item.id) === String(entry.recipeId));
        const safeId = escapeHtml(r.id);
        const totalTime = r.steps.reduce((s, x) => s + (Number(x.time) || 0), 0);
        return `
            <div class="today-card">
                <div class="today-card-header">
                    <div>
                        <span class="badge">${escapeHtml(r.category)} · ~${totalTime} мин.</span>
                        <div class="today-card-title" data-open-cook="${safeId}" style="margin-top:6px;">${escapeHtml(r.name)}</div>
                    </div>
                    <button type="button" class="btn btn-small btn-ghost" data-remove-today="${safeId}" style="color:#fa5252;">✕ Убрать</button>
                </div>
                <div class="today-card-controls">
                    <div class="mini-portions">
                        <span>Порций:</span>
                        <button type="button" data-today-port="${safeId}" data-delta="-1">−</button>
                        <strong>${entry.servings}</strong>
                        <button type="button" data-today-port="${safeId}" data-delta="1">+</button>
                    </div>
                    <button type="button" class="btn btn-small" data-open-cook="${safeId}">🍳 Готовить →</button>
                </div>
            </div>
        `;
    }).join('');
}

document.getElementById('today-list').addEventListener('click', (e) => {
    const removeBtn = e.target.closest('button[data-remove-today]');
    if (removeBtn) {
        toggleToday(removeBtn.dataset.removeToday);
        return;
    }

    const portBtn = e.target.closest('button[data-today-port]');
    if (portBtn) {
        const id = String(portBtn.dataset.todayPort);
        const delta = Number(portBtn.dataset.delta);
        const entry = todayMenu.find(item => String(item.recipeId) === id);
        if (entry) {
            entry.servings = Math.max(1, (entry.servings || 2) + delta);
            saveState();
            renderToday();
            renderCart();
            updateBadges();
        }
        return;
    }

    const cookTrigger = e.target.closest('[data-open-cook]');
    if (cookTrigger) {
        const id = cookTrigger.dataset.openCook;
        const entry = todayMenu.find(item => String(item.recipeId) === String(id));
        startCooking(id, entry ? entry.servings : undefined);
    }
});

document.getElementById('btn-go-cart').addEventListener('click', () => switchTab('cart'));

document.getElementById('btn-clear-today').addEventListener('click', () => {
    if (todayMenu.length === 0) return;
    if (confirm('Очистить список блюд на сегодня и убрать их продукты из корзины?')) {
        todayMenu.forEach(entry => clearCheckedForRecipe(entry.recipeId));
        todayMenu = [];
        saveState();
        renderAll();
    }
});

// --- Корзина покупок ---
function renderCart() {
    const content = document.getElementById('cart-content');
    const validToday = todayMenu.filter(item => recipes.some(r => String(r.id) === String(item.recipeId)));

    if (validToday.length === 0 && customCartItems.length === 0) {
        content.innerHTML = `
            <div class="empty-state" style="border:none; padding: 20px 10px;">
                Корзина пуста.<br>
                Добавьте блюда в раздел <strong>«🍽 Сегодня»</strong> или впишите нужный продукт в поле выше.
            </div>
        `;
        return;
    }

    let html = '';

    validToday.forEach(entry => {
        const r = recipes.find(item => String(item.id) === String(entry.recipeId));
        if (!r) return;
        html += `<div class="cart-group-title">${escapeHtml(r.name)} (${entry.servings} порц.)</div>`;
        r.ingredients.forEach((ing, idx) => {
            const key = `r_${r.id}_${idx}`;
            const checked = Boolean(cartChecked[key]);
            const scaled = scaleIngredient(ing, r.servings, entry.servings);
            html += `
                <div class="shopping-item ${checked ? 'checked' : ''}">
                    <label class="shopping-label">
                        <input type="checkbox" data-cart-key="${escapeHtml(key)}" ${checked ? 'checked' : ''}>
                        <span>${escapeHtml(scaled)}</span>
                    </label>
                </div>
            `;
        });
    });

    if (customCartItems.length > 0) {
        html += `<div class="cart-group-title">Дополнительные покупки</div>`;
        customCartItems.forEach((item, idx) => {
            html += `
                <div class="shopping-item ${item.checked ? 'checked' : ''}">
                    <label class="shopping-label">
                        <input type="checkbox" data-custom-idx="${idx}" ${item.checked ? 'checked' : ''}>
                        <span>${escapeHtml(item.text)}</span>
                    </label>
                    <button type="button" class="btn btn-small btn-ghost" data-del-custom="${idx}" style="color:#fa5252;">✕</button>
                </div>
            `;
        });
    }

    content.innerHTML = html;
}

document.getElementById('cart-content').addEventListener('change', (e) => {
    if (e.target.dataset.cartKey) {
        const key = e.target.dataset.cartKey;
        cartChecked[key] = e.target.checked;
        saveState();
        e.target.closest('.shopping-item').classList.toggle('checked', e.target.checked);
        updateBadges();
        return;
    }
    if (e.target.dataset.customIdx !== undefined) {
        const idx = Number(e.target.dataset.customIdx);
        if (customCartItems[idx]) {
            customCartItems[idx].checked = e.target.checked;
            saveState();
            e.target.closest('.shopping-item').classList.toggle('checked', e.target.checked);
            updateBadges();
        }
    }
});

document.getElementById('cart-content').addEventListener('click', (e) => {
    const delCustom = e.target.closest('button[data-del-custom]');
    if (delCustom) {
        customCartItems.splice(Number(delCustom.dataset.delCustom), 1);
        saveState();
        renderCart();
        updateBadges();
    }
});

document.getElementById('btn-add-custom-cart').addEventListener('click', addCustomCartItem);
document.getElementById('custom-cart-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') addCustomCartItem();
});

function addCustomCartItem() {
    const input = document.getElementById('custom-cart-input');
    const text = input.value.trim();
    if (!text) return;
    customCartItems.push({ text, checked: false });
    input.value = '';
    saveState();
    renderCart();
    updateBadges();
}

document.getElementById('btn-clear-checked').addEventListener('click', () => {
    customCartItems = customCartItems.filter(item => !item.checked);
    Object.keys(cartChecked).forEach(k => {
        if (cartChecked[k]) delete cartChecked[k];
    });
    saveState();
    renderCart();
    updateBadges();
});

// Скопировать некупленные продукты в мессенджер
document.getElementById('btn-copy-cart').addEventListener('click', () => {
    const validToday = todayMenu.filter(item => recipes.some(r => String(r.id) === String(item.recipeId)));
    const lines = ['🛒 Список покупок:'];
    let hasItems = false;

    validToday.forEach(entry => {
        const r = recipes.find(item => String(item.id) === String(entry.recipeId));
        if (!r) return;
        const dishLines = [];
        r.ingredients.forEach((ing, idx) => {
            const key = `r_${r.id}_${idx}`;
            if (!cartChecked[key]) {
                dishLines.push(`• ${scaleIngredient(ing, r.servings, entry.servings)}`);
            }
        });
        if (dishLines.length > 0) {
            hasItems = true;
            lines.push(`\n${r.name} (${entry.servings} порц.):`);
            lines.push(...dishLines);
        }
    });

    const unboughtCustom = customCartItems.filter(item => !item.checked);
    if (unboughtCustom.length > 0) {
        hasItems = true;
        lines.push('\nДополнительно:');
        unboughtCustom.forEach(item => lines.push(`• ${item.text}`));
    }

    if (!hasItems) {
        alert('В корзине нет некупленных продуктов.');
        return;
    }

    copyTextToClipboard(lines.join('\n'), '✅ Список покупок скопирован! Можно вставить в чат.');
});

function copyTextToClipboard(text, successMsg) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(() => {
            alert(successMsg);
        }).catch(() => {
            fallbackCopy(text, successMsg);
        });
    } else {
        fallbackCopy(text, successMsg);
    }
}

function fallbackCopy(text, successMsg) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try {
        document.execCommand('copy');
        alert(successMsg);
    } catch (e) {}
    document.body.removeChild(ta);
}

// --- Добавление и редактирование рецепта ---
function appendIngredientRow(val = '') {
    const row = document.createElement('div');
    row.className = 'dynamic-list-item';
    row.innerHTML = `
        <input type="text" class="ing-input" placeholder="Ингредиент - количество">
        <button type="button" class="btn btn-small btn-ghost btn-del-row" title="Удалить строку">✕</button>
    `;
    row.querySelector('input').value = val;
    document.getElementById('ingredients-container').appendChild(row);
}

function appendStepRow(desc = '', time = '') {
    const row = document.createElement('div');
    row.className = 'dynamic-list-item';
    row.innerHTML = `
        <input type="text" class="step-desc" placeholder="Описание шага">
        <input type="number" class="step-time" placeholder="Мин" min="0" style="max-width: 72px;">
        <button type="button" class="btn btn-small btn-ghost btn-del-row" title="Удалить шаг">✕</button>
    `;
    row.querySelector('.step-desc').value = desc;
    row.querySelector('.step-time').value = time;
    document.getElementById('steps-container').appendChild(row);
}

document.getElementById('ingredients-container').addEventListener('click', (e) => {
    const delBtn = e.target.closest('.btn-del-row');
    if (delBtn) delBtn.closest('.dynamic-list-item').remove();
});

document.getElementById('steps-container').addEventListener('click', (e) => {
    const delBtn = e.target.closest('.btn-del-row');
    if (delBtn) delBtn.closest('.dynamic-list-item').remove();
});

document.getElementById('btn-open-new').addEventListener('click', () => {
    document.getElementById('recipe-modal-title').innerText = 'Новый рецепт';
    document.getElementById('r-edit-id').value = '';
    document.getElementById('r-name').value = '';
    document.getElementById('r-category').value = 'Обед';
    document.getElementById('r-servings').value = '2';
    document.getElementById('ingredients-container').innerHTML = '';
    document.getElementById('steps-container').innerHTML = '';
    appendIngredientRow('');
    appendStepRow('', '');
    document.getElementById('recipe-modal').classList.add('open');
});

function openEditRecipeModal(id) {
    const r = recipes.find(item => String(item.id) === String(id));
    if (!r) return;

    document.getElementById('recipe-modal-title').innerText = 'Редактировать рецепт';
    document.getElementById('r-edit-id').value = r.id;
    document.getElementById('r-name').value = r.name;
    document.getElementById('r-category').value = r.category || 'Обед';
    document.getElementById('r-servings').value = r.servings || 2;

    const ingCont = document.getElementById('ingredients-container');
    ingCont.innerHTML = '';
    if (r.ingredients.length > 0) {
        r.ingredients.forEach(i => appendIngredientRow(i));
    } else {
        appendIngredientRow('');
    }

    const stepsCont = document.getElementById('steps-container');
    stepsCont.innerHTML = '';
    if (r.steps.length > 0) {
        r.steps.forEach(s => appendStepRow(s.desc, s.time || ''));
    } else {
        appendStepRow('', '');
    }

    document.getElementById('recipe-modal').classList.add('open');
}

document.getElementById('btn-close-recipe').addEventListener('click', () => {
    document.getElementById('recipe-modal').classList.remove('open');
});

document.getElementById('btn-add-ing').addEventListener('click', () => appendIngredientRow(''));
document.getElementById('btn-add-step').addEventListener('click', () => appendStepRow('', ''));

document.getElementById('btn-save-recipe').addEventListener('click', () => {
    const name = document.getElementById('r-name').value.trim();
    if (!name) return alert('Введите название рецепта!');

    const editId = document.getElementById('r-edit-id').value;
    const category = document.getElementById('r-category').value;
    const servings = parseInt(document.getElementById('r-servings').value, 10) || 2;
    const ingredients = Array.from(document.querySelectorAll('.ing-input')).map(i => i.value.trim()).filter(Boolean);
    const steps = Array.from(document.querySelectorAll('#steps-container .dynamic-list-item')).map(row => {
        const desc = row.querySelector('.step-desc').value.trim();
        const time = parseInt(row.querySelector('.step-time').value, 10) || 0;
        return desc ? { desc, time } : null;
    }).filter(Boolean);

    if (editId) {
        const idx = recipes.findIndex(r => String(r.id) === String(editId));
        if (idx !== -1) {
            recipes[idx] = { id: String(editId), name, category, servings, ingredients, steps };
        }
    } else {
        recipes.push({ id: String(Date.now()), name, category, servings, ingredients, steps });
    }

    saveState();
    renderAll();
    document.getElementById('recipe-modal').classList.remove('open');

    if (editId && currentCookingRecipe && String(currentCookingRecipe.id) === String(editId)) {
        startCooking(editId, currentPortions);
    }
});

// --- Режим готовки и таймеры ---
function startCooking(id, overrideServings) {
    const recipe = recipes.find(r => String(r.id) === String(id));
    if (!recipe) return;

    currentCookingRecipe = recipe;
    currentPortions = overrideServings || recipe.servings || 2;
    completedSteps = {};
    clearAllTimers();
    stopAlarm();

    const navCook = document.getElementById('nav-cook');
    navCook.style.display = 'inline-flex';
    switchTab('cook');

    renderCookingView();
}

function renderCookingView() {
    const recipe = currentCookingRecipe;
    if (!recipe) return;

    const fav = isFavorite(recipe.id);
    const today = isInToday(recipe.id);
    const view = document.getElementById('cook-view');

    view.innerHTML = `
        <h2>${escapeHtml(recipe.name)}</h2>
        <div class="cook-top-actions">
            <button type="button" class="btn btn-small ${fav ? 'btn-outline' : 'btn-ghost'}" id="cook-fav-btn">
                ${fav ? '❤️ В избранном' : '🤍 В избранное'}
            </button>
            <button type="button" class="btn btn-small ${today ? 'btn-success' : 'btn-outline'}" id="cook-today-btn">
                ${today ? '✅ В меню сегодня' : '+ Готовим сегодня'}
            </button>
            <button type="button" class="btn btn-small ${wakeLockDesired ? 'btn-wake' : 'btn-ghost'}" id="cook-wakelock-btn">
                ${wakeLockDesired ? '☀️ Экран включён' : '🌙 Не гасить экран'}
            </button>
            <button type="button" class="btn btn-small btn-ghost" id="cook-edit-btn">✏️ Изменить</button>
        </div>
        <div class="ingredients-box">
            <div style="font-weight:700; font-size:14px;">Количество порций:</div>
            <div class="portions-control">
                <button type="button" id="btn-port-minus">−</button>
                <span id="portion-count" style="font-weight:700; min-width:20px; text-align:center;">${currentPortions}</span>
                <button type="button" id="btn-port-plus">+</button>
            </div>
            <div style="font-weight:700; font-size:14px; margin-bottom:6px;">Ингредиенты:</div>
            <ul id="ingredients-render" style="margin-left: 20px; line-height: 1.6; font-size: 15px;"></ul>
        </div>
        <h3 style="margin-bottom: 4px;">Этапы приготовления:</h3>
        <p style="font-size: 12px; color: var(--muted); margin-bottom: 12px;">Нажмите на текст шага, чтобы отметить его выполненным.</p>
        <div id="steps-render">
            ${recipe.steps.map((step, idx) => `
                <div class="step-item ${completedSteps[idx] ? 'done' : ''}" data-step-box="${idx}">
                    <p class="step-text" data-toggle-step="${idx}"><strong>Шаг ${idx + 1}:</strong> ${escapeHtml(step.desc)}</p>
                    ${step.time > 0 ? `
                        <div class="timer-box">
                            <div class="time-display" id="time-display-${idx}">${step.time}:00</div>
                            <button type="button" class="btn btn-small" data-timer-toggle="${idx}" data-seconds="${step.time * 60}">▶ Старт</button>
                            <button type="button" class="btn btn-small btn-outline" data-timer-add="${idx}" data-seconds="${step.time * 60}">+1 мин</button>
                            <button type="button" class="btn btn-small btn-ghost" data-timer-reset="${idx}" data-seconds="${step.time * 60}">Сброс</button>
                        </div>
                    ` : ''}
                </div>
            `).join('')}
        </div>
    `;

    recalculateIngredients();
}

function recalculateIngredients() {
    const ul = document.getElementById('ingredients-render');
    if (!ul || !currentCookingRecipe) return;

    ul.innerHTML = currentCookingRecipe.ingredients.map(ing => {
        const scaled = scaleIngredient(ing, currentCookingRecipe.servings, currentPortions);
        return `<li>${escapeHtml(scaled)}</li>`;
    }).join('');
}

document.getElementById('cook-view').addEventListener('click', (e) => {
    if (!currentCookingRecipe) return;

    if (e.target.id === 'cook-fav-btn') {
        toggleFavorite(currentCookingRecipe.id);
        renderCookingView();
        return;
    }
    if (e.target.id === 'cook-today-btn') {
        toggleToday(currentCookingRecipe.id, currentPortions);
        renderCookingView();
        return;
    }
    if (e.target.id === 'cook-wakelock-btn') {
        toggleWakeLock();
        return;
    }
    if (e.target.id === 'cook-edit-btn') {
        openEditRecipeModal(currentCookingRecipe.id);
        return;
    }
    if (e.target.id === 'btn-port-minus') {
        if (currentPortions > 1) {
            currentPortions--;
            document.getElementById('portion-count').innerText = currentPortions;
            recalculateIngredients();
        }
        return;
    }
    if (e.target.id === 'btn-port-plus') {
        currentPortions++;
        document.getElementById('portion-count').innerText = currentPortions;
        recalculateIngredients();
        return;
    }

    const stepTrigger = e.target.closest('[data-toggle-step]');
    if (stepTrigger) {
        const idx = Number(stepTrigger.dataset.toggleStep);
        completedSteps[idx] = !completedSteps[idx];
        const box = document.querySelector(`.step-item[data-step-box="${idx}"]`);
        if (box) box.classList.toggle('done', completedSteps[idx]);
        return;
    }

    const toggleBtn = e.target.closest('button[data-timer-toggle]');
    if (toggleBtn) {
        toggleTimer(Number(toggleBtn.dataset.timerToggle), Number(toggleBtn.dataset.seconds), toggleBtn);
        return;
    }

    const addMinBtn = e.target.closest('button[data-timer-add]');
    if (addMinBtn) {
        addMinuteToTimer(Number(addMinBtn.dataset.timerAdd), Number(addMinBtn.dataset.seconds));
        return;
    }

    const resetBtn = e.target.closest('button[data-timer-reset]');
    if (resetBtn) {
        resetTimer(Number(resetBtn.dataset.timerReset), Number(resetBtn.dataset.seconds));
    }
});

// Разблокировка AudioContext на iOS при касании кнопки
function unlockAudio() {
    try {
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        if (!AudioCtx) return;
        if (!sharedAudioCtx) {
            sharedAudioCtx = new AudioCtx();
        }
        if (sharedAudioCtx.state === 'suspended') {
            sharedAudioCtx.resume();
        }
    } catch (e) {}
}

function playSingleBeep() {
    try {
        unlockAudio();
        if (!sharedAudioCtx) return;
        const now = sharedAudioCtx.currentTime;
        const osc = sharedAudioCtx.createOscillator();
        const gain = sharedAudioCtx.createGain();
        osc.connect(gain);
        gain.connect(sharedAudioCtx.destination);
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(880, now);
        osc.frequency.setValueAtTime(1100, now + 0.18);
        gain.gain.setValueAtTime(0.35, now);
        gain.gain.exponentialRampToValueAtTime(0.01, now + 0.5);
        osc.start(now);
        osc.stop(now + 0.52);
    } catch (e) {}
}

function triggerAlarm(idx) {
    const banner = document.getElementById('alarm-banner');
    const text = document.getElementById('alarm-text');
    if (text) text.innerText = `⏰ Шаг ${idx + 1} завершён!`;
    if (banner) banner.classList.add('active');

    playSingleBeep();
    if (navigator.vibrate) {
        try { navigator.vibrate([300, 150, 300]); } catch (e) {}
    }

    if (alarmRepeatInterval) clearInterval(alarmRepeatInterval);
    alarmRepeatInterval = setInterval(() => {
        playSingleBeep();
        if (navigator.vibrate) {
            try { navigator.vibrate([300, 150, 300]); } catch (e) {}
        }
    }, 2000);
}

function stopAlarm() {
    if (alarmRepeatInterval) {
        clearInterval(alarmRepeatInterval);
        alarmRepeatInterval = null;
    }
    const banner = document.getElementById('alarm-banner');
    if (banner) banner.classList.remove('active');
}

document.getElementById('btn-stop-alarm').addEventListener('click', stopAlarm);

function toggleTimer(idx, totalSeconds, btn) {
    unlockAudio();
    stopAlarm();

    if (!activeTimers[idx]) {
        activeTimers[idx] = { remaining: totalSeconds, endTime: null, intervalId: null };
    }

    // Пауза
    if (activeTimers[idx].intervalId !== null) {
        const left = Math.max(0, Math.ceil((activeTimers[idx].endTime - Date.now()) / 1000));
        clearInterval(activeTimers[idx].intervalId);
        activeTimers[idx].intervalId = null;
        activeTimers[idx].endTime = null;
        activeTimers[idx].remaining = left;
        updateTimerDisplay(idx);
        btn.innerText = '▶ Продолжить';
        btn.style.background = 'var(--primary)';
        return;
    }

    // Если таймер уже дошёл до 0 — сбрасываем перед новым стартом
    if (activeTimers[idx].remaining <= 0) {
        activeTimers[idx].remaining = totalSeconds;
        updateTimerDisplay(idx);
    }

    activeTimers[idx].endTime = Date.now() + activeTimers[idx].remaining * 1000;
    btn.innerText = '⏸ Пауза';
    btn.style.background = 'var(--accent)';

    const display = document.getElementById('time-display-' + idx);
    if (display) display.style.color = 'var(--text)';

    activeTimers[idx].intervalId = setInterval(() => {
        syncTimerTick(idx, btn);
    }, 250);
}

function syncTimerTick(idx, btn) {
    const timer = activeTimers[idx];
    if (!timer || !timer.endTime) return;

    const left = Math.max(0, Math.ceil((timer.endTime - Date.now()) / 1000));
    if (left !== timer.remaining) {
        timer.remaining = left;
        updateTimerDisplay(idx);
    }

    if (left <= 0) {
        clearInterval(timer.intervalId);
        timer.intervalId = null;
        timer.endTime = null;
        const display = document.getElementById('time-display-' + idx);
        if (display) display.style.color = 'var(--success)';
        const targetBtn = btn || document.querySelector(`button[data-timer-toggle="${idx}"]`);
        if (targetBtn) {
            targetBtn.innerText = '🔄 Заново';
            targetBtn.style.background = 'var(--success)';
        }
        triggerAlarm(idx);
    }
}

function addMinuteToTimer(idx, totalSeconds) {
    if (!activeTimers[idx]) {
        activeTimers[idx] = { remaining: totalSeconds, endTime: null, intervalId: null };
    }
    activeTimers[idx].remaining += 60;
    if (activeTimers[idx].endTime) {
        activeTimers[idx].endTime += 60000;
    }
    updateTimerDisplay(idx);
}

function resetTimer(idx, totalSeconds) {
    stopAlarm();
    if (activeTimers[idx] && activeTimers[idx].intervalId !== null) {
        clearInterval(activeTimers[idx].intervalId);
    }
    activeTimers[idx] = { remaining: totalSeconds, endTime: null, intervalId: null };
    updateTimerDisplay(idx);

    const display = document.getElementById('time-display-' + idx);
    if (display) display.style.color = 'var(--text)';

    const btn = document.querySelector(`button[data-timer-toggle="${idx}"]`);
    if (btn) {
        btn.innerText = '▶ Старт';
        btn.style.background = 'var(--primary)';
    }
}

function updateTimerDisplay(idx) {
    const display = document.getElementById('time-display-' + idx);
    if (!display || !activeTimers[idx]) return;
    const sec = Math.max(0, activeTimers[idx].remaining);
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    display.innerText = `${m}:${s < 10 ? '0' : ''}${s}`;
}

function clearAllTimers() {
    Object.values(activeTimers).forEach(t => {
        if (t && t.intervalId !== null) clearInterval(t.intervalId);
    });
    activeTimers = {};
}

// Пересчёт таймеров и восстановление Wake Lock при возврате из фона / разблокировке экрана
document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
        Object.keys(activeTimers).forEach(key => {
            const idx = Number(key);
            if (activeTimers[idx] && activeTimers[idx].endTime) {
                syncTimerTick(idx);
            }
        });
        if (wakeLockDesired && !wakeLockSentinel) {
            requestWakeLock();
        }
    }
});

// --- Резервное копирование и восстановление ---
function downloadTextFile(filename, content, mimeType) {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function normalizeRecipesList(arr) {
    return arr.map(r => ({
        id: String(r.id || Date.now() + Math.random()),
        name: r.name || 'Без названия',
        category: r.category || 'Обед',
        servings: Number(r.servings) || 2,
        ingredients: Array.isArray(r.ingredients) ? r.ingredients : [],
        steps: Array.isArray(r.steps) ? r.steps : []
    }));
}

function importFromRawString(raw) {
    let cleaned = raw.trim();
    if (!cleaned) return alert('Файл или текстовое поле пустое!');

    cleaned = cleaned.replace(/^(const|let|var)\s+defaultRecipes\s*=\s*/i, '');
    cleaned = cleaned.replace(/;\s*$/, '');

    try {
        const parsed = JSON.parse(cleaned);

        if (Array.isArray(parsed)) {
            if (recipes.length > 0 && !confirm(`Заменить текущую базу (${recipes.length} шт.) на загруженную (${parsed.length} шт.)?`)) {
                return;
            }
            recipes = normalizeRecipesList(parsed);
            deletedDefaultIds = [];
            saveState();
            renderAll();
            document.getElementById('import-modal').classList.remove('open');
            alert(`✅ Загружено рецептов: ${recipes.length}`);
            return;
        }

        if (parsed && typeof parsed === 'object' && Array.isArray(parsed.recipes)) {
            if (recipes.length > 0 && !confirm(`Заменить текущую базу (${recipes.length} шт.) на бэкап (${parsed.recipes.length} шт.)?`)) {
                return;
            }
            recipes = normalizeRecipesList(parsed.recipes);
            if (Array.isArray(parsed.favoriteIds)) {
                favoriteIds = parsed.favoriteIds.map(String);
            }
            if (Array.isArray(parsed.deletedDefaultIds)) {
                deletedDefaultIds = parsed.deletedDefaultIds.map(String);
            } else {
                deletedDefaultIds = [];
            }
            saveState();
            renderAll();
            document.getElementById('import-modal').classList.remove('open');
            alert(`✅ Бэкап восстановлен! Рецептов: ${recipes.length}`);
            return;
        }

        alert('❌ Неверный формат файла или кода.');
    } catch (e) {
        alert('❌ Не удалось прочитать данные. Проверьте, что файл или код не повреждены.');
    }
}

document.getElementById('btn-open-import').addEventListener('click', () => {
    document.getElementById('import-textarea').value = '';
    document.getElementById('import-modal').classList.add('open');
});

document.getElementById('btn-close-import').addEventListener('click', () => {
    document.getElementById('import-modal').classList.remove('open');
});

document.getElementById('btn-download-json').addEventListener('click', () => {
    const backupData = {
        exportedAt: new Date().toISOString(),
        recipes: recipes,
        favoriteIds: favoriteIds,
        deletedDefaultIds: deletedDefaultIds
    };
    const dateStr = new Date().toISOString().slice(0, 10);
    const json = JSON.stringify(backupData, null, 2);
    downloadTextFile(`recepty-backup-${dateStr}.json`, json, 'application/json;charset=utf-8');
});

document.getElementById('btn-upload-file').addEventListener('click', () => {
    const fileInput = document.getElementById('import-file-input');
    fileInput.value = '';
    fileInput.click();
});

document.getElementById('import-file-input').addEventListener('change', (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
        importFromRawString(String(ev.target.result || ''));
    };
    reader.readAsText(file, 'UTF-8');
});

document.getElementById('btn-export-js').addEventListener('click', () => {
    const textarea = document.getElementById('import-textarea');
    const jsCode = `const defaultRecipes = ${JSON.stringify(recipes, null, 4)};\n`;
    textarea.value = jsCode;
    textarea.select();
    copyTextToClipboard(jsCode, '✅ Код для recipes.js скопирован! Можешь вставить его в файл recipes.js на GitHub.');
});

document.getElementById('btn-do-import').addEventListener('click', () => {
    const raw = document.getElementById('import-textarea').value;
    importFromRawString(raw);
});

function renderAll() {
    renderRecipes();
    renderFavorites();
    renderToday();
    renderCart();
    updateBadges();
}

renderAll();