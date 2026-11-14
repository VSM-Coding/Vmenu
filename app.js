window.onerror = function(msg, url, line) {
    const banner = document.getElementById('error-banner');
    if (banner) {
        banner.style.display = 'block';
        banner.innerText = 'Ошибка в коде (строка ' + line + '): ' + msg;
    }
};

const SEED_VERSION = 'v2_21_recipes';
let recipes = [];

try {
    const saved = JSON.parse(localStorage.getItem('my_recipes'));
    const currentSeed = localStorage.getItem('recipes_seed_version');

    if (Array.isArray(saved) && saved.length > 0) {
        recipes = saved.map(r => ({
            id: String(r.id || Date.now()),
            name: r.name || 'Без названия',
            category: r.category || 'Обед',
            servings: Number(r.servings) || 2,
            ingredients: Array.isArray(r.ingredients) ? r.ingredients : [],
            steps: Array.isArray(r.steps) ? r.steps : []
        }));

        if (currentSeed !== SEED_VERSION) {
            defaultRecipes.forEach(def => {
                if (!recipes.some(r => r.id === def.id)) {
                    recipes.push(def);
                }
            });
            localStorage.setItem('my_recipes', JSON.stringify(recipes));
            localStorage.setItem('recipes_seed_version', SEED_VERSION);
        }
    } else {
        recipes = [...defaultRecipes];
        localStorage.setItem('my_recipes', JSON.stringify(recipes));
        localStorage.setItem('recipes_seed_version', SEED_VERSION);
    }
} catch (e) {
    recipes = [...defaultRecipes];
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
let activeCategory = 'все';

function escapeHtml(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function scaleIngredient(ing, baseServings, targetServings) {
    const ratio = targetServings / (baseServings || 2);
    return String(ing).replace(/(\d+(?:[.,]\d+)?)(?!\s*%)/g, (match) => {
        const num = parseFloat(match.replace(',', '.'));
        if (isNaN(num)) return match;
        const res = Math.round(num * ratio * 10) / 10;
        return String(res).replace('.', ',');
    });
}

function saveState() {
    localStorage.setItem('my_recipes', JSON.stringify(recipes));
    localStorage.setItem('favorite_recipes', JSON.stringify(favoriteIds));
    localStorage.setItem('today_recipes', JSON.stringify(todayMenu));
    localStorage.setItem('cart_checked', JSON.stringify(cartChecked));
    localStorage.setItem('cart_custom_items', JSON.stringify(customCartItems));
}

function isFavorite(id) {
    return favoriteIds.includes(String(id));
}

function isInToday(id) {
    return todayMenu.some(item => String(item.recipeId) === String(id));
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
                <button type="button" class="fav-btn ${fav ? 'is-fav' : ''}" data-fav-id="${r.id}" title="В избранное">
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
                <button type="button" class="btn btn-small ${today ? 'btn-success' : 'btn-outline'}" data-today-id="${r.id}">
                    ${today ? '✅ На сегодня' : '+ На сегодня'}
                </button>
                <div class="card-icon-group">
                    <button type="button" class="btn btn-small btn-ghost" data-edit-id="${r.id}" title="Редактировать">✏️</button>
                    <button type="button" class="btn btn-small btn-ghost" data-delete-id="${r.id}" style="color:#fa5252;" title="Удалить">🗑</button>
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
        const id = delBtn.dataset.deleteId;
        if (confirm('Удалить этот рецепт из базы?')) {
            recipes = recipes.filter(r => String(r.id) !== String(id));
            favoriteIds = favoriteIds.filter(x => String(x) !== String(id));
            todayMenu = todayMenu.filter(x => String(x.recipeId) !== String(id));
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
        const totalTime = r.steps.reduce((s, x) => s + (Number(x.time) || 0), 0);
        return `
            <div class="today-card">
                <div class="today-card-header">
                    <div>
                        <span class="badge">${escapeHtml(r.category)} · ~${totalTime} мин.</span>
                        <div class="today-card-title" data-open-cook="${r.id}" style="margin-top:6px;">${escapeHtml(r.name)}</div>
                    </div>
                    <button type="button" class="btn btn-small btn-ghost" data-remove-today="${r.id}" style="color:#fa5252;">✕ Убрать</button>
                </div>
                <div class="today-card-controls">
                    <div class="mini-portions">
                        <span>Порций:</span>
                        <button type="button" data-today-port="${r.id}" data-delta="-1">−</button>
                        <strong>${entry.servings}</strong>
                        <button type="button" data-today-port="${r.id}" data-delta="1">+</button>
                    </div>
                    <button type="button" class="btn btn-small" data-open-cook="${r.id}">🍳 Готовить →</button>
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
                        <input type="checkbox" data-cart-key="${key}" ${checked ? 'checked' : ''}>
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

// --- Добавление и редактирование рецепта ---
function appendIngredientRow(val = '') {
    const row = document.createElement('div');
    row.className = 'dynamic-list-item';
    row.innerHTML = `<input type="text" class="ing-input" placeholder="Ингредиент - количество">`;
    row.querySelector('input').value = val;
    document.getElementById('ingredients-container').appendChild(row);
}

function appendStepRow(desc = '', time = '') {
    const row = document.createElement('div');
    row.className = 'dynamic-list-item';
    row.innerHTML = `
        <input type="text" class="step-desc" placeholder="Описание шага">
        <input type="number" class="step-time" placeholder="Мин" min="0" style="max-width: 80px;">
    `;
    row.querySelector('.step-desc').value = desc;
    row.querySelector('.step-time').value = time;
    document.getElementById('steps-container').appendChild(row);
}

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
        startCooking(editId);
    }
});

// --- Режим готовки и таймеры ---
function startCooking(id, overrideServings) {
    const recipe = recipes.find(r => String(r.id) === String(id));
    if (!recipe) return;

    currentCookingRecipe = recipe;
    currentPortions = overrideServings || recipe.servings || 2;
    clearAllTimers();

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
        <h3 style="margin-bottom: 12px;">Этапы приготовления:</h3>
        <div id="steps-render">
            ${recipe.steps.map((step, idx) => `
                <div class="step-item">
                    <p><strong>Шаг ${idx + 1}:</strong> ${escapeHtml(step.desc)}</p>
                    ${step.time > 0 ? `
                        <div class="timer-box">
                            <div class="time-display" id="time-display-${idx}">${step.time}:00</div>
                            <button type="button" class="btn btn-small" data-timer-toggle="${idx}" data-seconds="${step.time * 60}">▶ Старт</button>
                            <button type="button" class="btn btn-small btn-outline" data-timer-reset="${idx}" data-seconds="${step.time * 60}">Сброс</button>
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

    const toggleBtn = e.target.closest('button[data-timer-toggle]');
    if (toggleBtn) {
        toggleTimer(Number(toggleBtn.dataset.timerToggle), Number(toggleBtn.dataset.seconds), toggleBtn);
        return;
    }

    const resetBtn = e.target.closest('button[data-timer-reset]');
    if (resetBtn) {
        resetTimer(Number(resetBtn.dataset.timerReset), Number(resetBtn.dataset.seconds));
    }
});

function toggleTimer(idx, totalSeconds, btn) {
    if (!activeTimers[idx]) {
        activeTimers[idx] = { remaining: totalSeconds, intervalId: null };
    }

    if (activeTimers[idx].intervalId !== null) {
        clearInterval(activeTimers[idx].intervalId);
        activeTimers[idx].intervalId = null;
        btn.innerText = '▶ Продолжить';
        btn.style.background = 'var(--primary)';
        return;
    }

    if (activeTimers[idx].remaining <= 0) {
        activeTimers[idx].remaining = totalSeconds;
        updateTimerDisplay(idx);
    }

    btn.innerText = '⏸ Пауза';
    btn.style.background = 'var(--accent)';
    const display = document.getElementById('time-display-' + idx);
    if (display) display.style.color = 'var(--text)';

    activeTimers[idx].intervalId = setInterval(() => {
        activeTimers[idx].remaining--;
        updateTimerDisplay(idx);

        if (activeTimers[idx].remaining <= 0) {
            clearInterval(activeTimers[idx].intervalId);
            activeTimers[idx].intervalId = null;
            if (display) display.style.color = 'var(--success)';
            btn.innerText = '🔄 Заново';
            btn.style.background = 'var(--success)';
            playAlarm();
            alert(`⏰ Шаг ${idx + 1} завершён!`);
        }
    }, 1000);
}

function resetTimer(idx, totalSeconds) {
    if (activeTimers[idx] && activeTimers[idx].intervalId !== null) {
        clearInterval(activeTimers[idx].intervalId);
    }
    activeTimers[idx] = { remaining: totalSeconds, intervalId: null };
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

function playAlarm() {
    try {
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        const ctx = new AudioCtx();
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(880, ctx.currentTime);
        gain.gain.setValueAtTime(0.3, ctx.currentTime);
        osc.start();
        setTimeout(() => osc.stop(), 1200);
    } catch (e) {}
}

// --- Импорт и Экспорт ---
document.getElementById('btn-open-import').addEventListener('click', () => {
    document.getElementById('import-textarea').value = '';
    document.getElementById('import-modal').classList.add('open');
});

document.getElementById('btn-close-import').addEventListener('click', () => {
    document.getElementById('import-modal').classList.remove('open');
});

document.getElementById('btn-do-export').addEventListener('click', () => {
    const textarea = document.getElementById('import-textarea');
    const json = JSON.stringify(recipes, null, 2);
    textarea.value = json;
    textarea.select();
    if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(json).then(() => {
            alert('✅ Код базы рецептов скопирован в буфер обмена!');
        }).catch(() => {});
    }
});

document.getElementById('btn-do-import').addEventListener('click', () => {
    const raw = document.getElementById('import-textarea').value.trim();
    if (!raw) return alert('Сначала вставьте код в текстовое поле!');
    try {
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) return alert('❌ Неверный формат: ожидается список рецептов.');
        recipes = parsed.map(r => ({
            id: String(r.id || Date.now()),
            name: r.name || 'Без названия',
            category: r.category || 'Обед',
            servings: Number(r.servings) || 2,
            ingredients: Array.isArray(r.ingredients) ? r.ingredients : [],
            steps: Array.isArray(r.steps) ? r.steps : []
        }));
        saveState();
        renderAll();
        document.getElementById('import-modal').classList.remove('open');
        alert('✅ Рецепты успешно загружены!');
    } catch (e) {
        alert('❌ Ошибка чтения JSON. Проверьте, что код скопирован полностью.');
    }
});

function renderAll() {
    renderRecipes();
    renderFavorites();
    renderToday();
    renderCart();
    updateBadges();
}

renderAll();