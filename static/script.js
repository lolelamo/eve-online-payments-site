// Application state
let appData = {
    config: {
        levelValues: {},
        hasSalvager: false,
        salvagerPercent: 10,
        currency: 'ISK',
        autoCalculate: true,
        numberFormat: 'comma'
    },
    members: [],
    sites: []
};

let calculations = null;
let saveTimeout = null;
let csrfToken = null;

// Generate UUID for member IDs (fixes collision risk)
function generateUUID() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
        const r = Math.random() * 16 | 0;
        const v = c === 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    });
}

// Security logging
function logAction(action, details = {}) {
    const timestamp = new Date().toISOString();
    const logEntry = {
        timestamp,
        action,
        details,
        userAgent: navigator.userAgent,
        url: window.location.href
    };
    console.log('[SECURITY LOG]', JSON.stringify(logEntry, null, 2));
}

// Format number display based on user preference
function formatNumber(num, format = null) {
    const fmt = format || appData.config.numberFormat || 'comma';
    const num_int = Math.round(num);
    
    if (fmt === 'space') return num_int.toLocaleString('de-DE');
    if (fmt === 'dot') return num_int.toLocaleString('it-IT');
    return num_int.toLocaleString('en-US');
}

// Parse formatted number back to integer
function parseFormattedNumber(str) {
    if (!str) return 0;
    return parseInt(str.replace(/[^\d]/g, '')) || 0;
}

// Show loading overlay
function showLoading() {
    logAction('UI_LOADING_SHOW');
    document.getElementById('loadingOverlay').classList.add('active');
}

// Hide loading overlay
function hideLoading() {
    logAction('UI_LOADING_HIDE');
    document.getElementById('loadingOverlay').classList.remove('active');
}

// Show error modal (FIXED - was missing)
function showErrorModal(error, context = {}) {
    logAction('UI_ERROR_MODAL_SHOW', { error: error.message, context });
    
    const modal = document.getElementById('errorModal');
    if (!modal) {
        // Fallback if modal doesn't exist
        console.error('Error:', error.message);
        showMessage(error.message, 'error');
        return;
    }
    
    const header = modal.querySelector('.error-modal-header h2');
    const body = modal.querySelector('.error-modal-body');
    
    header.textContent = 'Error Loading Data';
    body.innerHTML = `
        <div class="error-message-text">
            <strong>Error:</strong> ${error.message}
        </div>
        <div class="error-details">
            <h3>Context Information:</h3>
            <div class="error-code">${JSON.stringify(context, null, 2)}</div>
        </div>
        <div class="error-actions">
            <button class="btn" onclick="location.reload()">Retry</button>
            <button class="btn btn-secondary" onclick="closeErrorModal()">Continue Anyway</button>
        </div>
    `;
    
    modal.classList.add('active');
}

function closeErrorModal() {
    const modal = document.getElementById('errorModal');
    if (modal) modal.classList.remove('active');
    renderAll();
}

// Show message to user
function showMessage(message, type = 'success') {
    logAction('UI_MESSAGE_DISPLAY', { message, type });
    const className = type === 'success' ? 'success-message' : 'error-message';
    const section = document.querySelector('.tab-content.active .section');
    if (!section) {
        console.warn('No active section found for message display');
        return;
    }
    
    const msg = document.createElement('div');
    msg.className = className;
    msg.textContent = message;
    section.insertBefore(msg, section.firstChild);
    setTimeout(() => msg.remove(), 3000);
}

// Update data status indicator
function updateDataStatus(status = 'saved') {
    logAction('UI_DATA_STATUS_UPDATE', { status });
    const indicator = document.getElementById('dataStatus');
    if (status === 'saving') {
        indicator.textContent = 'Guardando...';
        indicator.style.background = 'rgba(255,255,255,0.1)';
    } else {
        indicator.textContent = 'Guardado';
        indicator.style.background = 'rgba(255,255,255,0.1)';
    }
}

// Load CSRF token
async function loadCSRFToken() {
    try {
        const response = await fetch('/api/csrf-token');
        const data = await response.json();
        csrfToken = data.csrf_token;
    } catch (error) {
        console.error('Error loading CSRF token:', error);
    }
}

// Load data from server (FIXED - handles new users)
async function loadData() {
    logAction('DATA_LOAD_START');
    showLoading();
    try {
        const response = await fetch('/api/data');
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`HTTP ${response.status}: ${errorText}`);
        }
        const data = await response.json();
        
        console.log('[DEBUG] Data loaded from server:', data);
        console.log('[DEBUG] Config:', data.config);
        console.log('[DEBUG] Level Values:', data.config?.levelValues);
        
        logAction('DATA_LOAD_SUCCESS', { 
            memberCount: data.members?.length, 
            siteCount: data.sites?.length,
            hasConfig: !!data.config,
            hasLevelValues: !!data.config?.levelValues
        });
        
        appData = data;
        calculations = data.calculations || null;
        renderAll();
        updatePaymentsDisplay();
        hideLoading();
    } catch (error) {
        logAction('DATA_LOAD_ERROR', { error: error.message });
        console.error('Error loading data:', error);
        hideLoading();
        
        showErrorModal(error, {
            action: 'LOAD_DATA',
            endpoint: '/api/data'
        });
    }
}

// Save data to server with debouncing (FIXED - includes CSRF token)
async function saveData() {
    logAction('DATA_SAVE_TRIGGERED');
    updateDataStatus('saving');
    
    if (saveTimeout) clearTimeout(saveTimeout);
    
    saveTimeout = setTimeout(async () => {
        try {
            logAction('DATA_SAVE_REQUEST', { 
                memberCount: appData.members.length, 
                siteCount: appData.sites.length 
            });
            
            const response = await fetch('/api/data', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-CSRFToken': csrfToken || ''
                },
                body: JSON.stringify(appData)
            });
            
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            
            const result = await response.json();
            logAction('DATA_SAVE_SUCCESS');
            
            if (result.calculations) {
                calculations = result.calculations;
                updatePaymentsDisplay();
            }
            updateDataStatus('saved');
        } catch (error) {
            logAction('DATA_SAVE_ERROR', { error: error.message });
            console.error('Error saving data:', error);
            showMessage('Error al guardar datos', 'error');
            updateDataStatus('error');
        }
    }, 500);
}

// Render all UI components
function renderAll() {
    logAction('UI_RENDER_ALL');
    renderLevelValues();
    updateMembersList();
    updateSitesList();
    updateParticipantCheckboxes();
    updateBadges();
    
    const config = appData.config || {};
    document.getElementById('hasSalvager').checked = config.hasSalvager || false;
    document.getElementById('salvagerPercent').value = config.salvagerPercent || 10;
    document.getElementById('currency').value = config.currency || 'ISK';
    document.getElementById('autoCalculate').checked = config.autoCalculate !== false;
    
    // Set format selector
    const format = config.numberFormat || 'comma';
    document.querySelectorAll('.format-option').forEach(opt => {
        opt.classList.remove('active');
    });
    const formatOption = document.querySelector(`.format-option[data-format="${format}"]`);
    if (formatOption) {
        formatOption.classList.add('active');
    }
    
    updateSalvagerSettings();
    updateAutoCalcIndicator();
    checkMembersExist();
}

// Update badge counters
function updateBadges() {
    const memberCount = appData.members.length;
    const siteCount = appData.sites.length;
    document.getElementById('memberBadge').textContent = memberCount;
    document.getElementById('siteBadge').textContent = siteCount;
    logAction('UI_BADGES_UPDATE', { memberCount, siteCount });
}

// Update auto-calc indicator
function updateAutoCalcIndicator() {
    const indicator = document.getElementById('autoCalcIndicator');
    if (appData.config.autoCalculate) {
        indicator.classList.add('active');
        indicator.textContent = 'Cálculo Automático';
    } else {
        indicator.classList.remove('active');
        indicator.textContent = 'Manual';
    }
}

// Render level values configuration
function renderLevelValues() {
    logAction('UI_RENDER_LEVEL_VALUES');
    const container = document.getElementById('levelValues');
    container.innerHTML = '';
    
    if (!appData.config.levelValues) {
        appData.config.levelValues = {};
    }
    if (!appData.config.levelNames) {
        appData.config.levelNames = {};
    }
    
    const levelValues = appData.config.levelValues;
    const levelNames = appData.config.levelNames;
    
    for (let i = 1; i <= 10; i++) {
        const div = document.createElement('div');
        div.className = 'level-card';
        
        const nameVal = levelNames[i] || levelNames[String(i)] || `Sitio ${i}`;
        const amountVal = levelValues[i] || levelValues[String(i)] || 0;
        const formattedAmount = formatNumber(amountVal);
        
        div.innerHTML = `
            <label>NIVEL ${i}</label>
            <input type="text" 
                   id="levelName${i}" 
                   value="${nameVal}" 
                   placeholder="Nombre del Sitio"
                   autocomplete="off">
            <input type="text" 
                   id="level${i}" 
                   value="${formattedAmount}" 
                   placeholder="Valor en ISK"
                   class="number-input"
                   autocomplete="off"
                   data-raw-value="${amountVal}">
        `;
        container.appendChild(div);
        
        const input = document.getElementById(`level${i}`);
        input.addEventListener('input', handleNumberInput);
        input.addEventListener('blur', handleNumberBlur);
        input.addEventListener('focus', handleNumberFocus);
    }
    
    console.log('[DEBUG] Level values rendered:', levelValues);
}

// Handle number input with formatting
function handleNumberInput(e) {
    const input = e.target;
    let value = input.value;
    
    value = value.replace(/[^\d]/g, '');
    input.dataset.rawValue = value;
    
    if (value) {
        input.value = formatNumber(value);
    }
}

// Handle blur - ensure formatting
function handleNumberBlur(e) {
    const input = e.target;
    const rawValue = input.dataset.rawValue || '0';
    
    if (rawValue === '' || rawValue === '0') {
        input.value = '0';
        input.dataset.rawValue = '0';
    } else {
        input.value = formatNumber(rawValue);
    }
}

// Handle focus - select all for easy editing
function handleNumberFocus(e) {
    e.target.select();
}

// Reset levels to default values
function resetLevels() {
    logAction('CONFIG_RESET_LEVELS_ATTEMPT');
    if (!confirm('¿Restaurar valores por defecto? Esto sobrescribirá los valores actuales.')) {
        logAction('CONFIG_RESET_LEVELS_CANCELLED');
        return;
    }
    
    logAction('CONFIG_RESET_LEVELS_CONFIRMED');
    for (let i = 1; i <= 10; i++) {
        const defaultValue = i * 100000;
        const input = document.getElementById(`level${i}`);
        input.value = formatNumber(defaultValue);
        input.dataset.rawValue = defaultValue.toString();
        document.getElementById(`levelName${i}`).value = `Sitio ${i}`;
    }
    
    showMessage('Valores restaurados a los predeterminados');
}

// Save configuration
function saveConfig() {
    logAction('CONFIG_SAVE_START');
    
    if (!appData.config.levelNames) appData.config.levelNames = {};
    if (!appData.config.levelValues) appData.config.levelValues = {};
    
    for (let i = 1; i <= 10; i++) {
        const levelInput = document.getElementById(`level${i}`);
        const levelValue = parseFormattedNumber(levelInput.dataset.rawValue || levelInput.value);
        const levelName = (document.getElementById(`levelName${i}`) || { value: `Sitio ${i}` }).value.trim() || `Sitio ${i}`;
        
        // Validate level value (FIXED)
        if (levelValue < 0 || levelValue > 999999999999) {
            showMessage(`Valor de nivel ${i} inválido`, 'error');
            return;
        }
        
        appData.config.levelValues[i] = levelValue;
        appData.config.levelValues[String(i)] = levelValue;
        appData.config.levelNames[i] = levelName;
        appData.config.levelNames[String(i)] = levelName;
    }
    
    appData.config.hasSalvager = document.getElementById('hasSalvager').checked;
    appData.config.salvagerPercent = parseFloat(document.getElementById('salvagerPercent').value);
    appData.config.currency = document.getElementById('currency').value;
    appData.config.autoCalculate = document.getElementById('autoCalculate').checked;
    
    logAction('CONFIG_SAVE_COMPLETE', { config: appData.config });
    saveData();
    updateAutoCalcIndicator();
    showMessage('Configuración guardada correctamente');
}

// Switch between tabs
function showTab(tabName) {
    logAction('UI_TAB_SWITCH', { tabName });
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
    
    const activeTab = document.querySelector(`.tab[data-tab="${tabName}"]`);
    const activeContent = document.getElementById(tabName);
    
    if (activeTab) activeTab.classList.add('active');
    if (activeContent) activeContent.classList.add('active');
}

// Update salvager settings UI
function updateSalvagerSettings() {
    const hasSalvager = document.getElementById('hasSalvager').checked;
    document.getElementById('salvagerPercent').disabled = !hasSalvager;
}

// Check if members exist and update UI
function checkMembersExist() {
    const warning = document.getElementById('noMembersWarning');
    const addSiteBtn = document.getElementById('addSiteBtn');
    
    if (appData.members.length === 0) {
        if (warning) warning.style.display = 'block';
        if (addSiteBtn) addSiteBtn.disabled = true;
    } else {
        if (warning) warning.style.display = 'none';
        if (addSiteBtn) addSiteBtn.disabled = false;
    }
}

// Add member(s) (FIXED - uses UUID for ID)
function addMember(evt) {
    evt.preventDefault();
    logAction('MEMBER_ADD_ATTEMPT');
    
    const nameInput = document.getElementById('memberName');
    const raw = nameInput.value;
    const isSalvager = document.getElementById('isSalvager').checked;
    const names = raw.split(/[\n,]+/).map(n => n.trim()).filter(Boolean);
    
    if (names.length === 0) {
        logAction('MEMBER_ADD_VALIDATION_FAILED', { reason: 'empty_name' });
        alert('Ingresa un nombre');
        nameInput.focus();
        return;
    }
    
    logAction('MEMBER_ADD_SUCCESS', { names, isSalvager, count: names.length });
    names.forEach(n => {
        appData.members.push({ 
            name: n, 
            isSalvager, 
            id: generateUUID()  // FIXED: UUID instead of Date.now()
        });
    });
    
    nameInput.value = '';
    document.getElementById('isSalvager').checked = false;
    
    saveData();
    updateMembersList();
    updateParticipantCheckboxes();
    updateBadges();
    checkMembersExist();
    nameInput.focus();
    
    showMessage(`${names.length} miembro(s) agregado(s)`);
}

// Remove member
function removeMember(id) {
    logAction('MEMBER_REMOVE_ATTEMPT', { memberId: id });
    
    const member = appData.members.find(m => m.id === id);
    if (!confirm(`¿Eliminar a ${member?.name || 'este miembro'}?`)) {
        logAction('MEMBER_REMOVE_CANCELLED', { memberId: id });
        return;
    }
    
    logAction('MEMBER_REMOVE_CONFIRMED', { memberId: id, memberName: member?.name });
    appData.members = appData.members.filter(m => m.id !== id);
    saveData();
    updateMembersList();
    updateParticipantCheckboxes();
    updateBadges();
    checkMembersExist();
}

// Update members list UI
function updateMembersList() {
    const container = document.getElementById('membersList');
    document.getElementById('memberCount').textContent = appData.members.length;
    
    if (appData.members.length === 0) {
        container.innerHTML = '<div class="empty-state"><p>No hay miembros registrados</p><p style="font-size: 0.9em; margin-top: 10px;">Agrega miembros para comenzar</p></div>';
        return;
    }
    
    container.innerHTML = appData.members.map(m => `
        <div class="member-item ${m.isSalvager ? 'salvager' : ''}">
            <div class="member-info">
                <span>${m.name}</span>
                ${m.isSalvager ? '<span class="salvager-tag">SALVAGER</span>' : ''}
            </div>
            <div class="member-controls">
                <button class="btn btn-danger" onclick="removeMember('${m.id}')">Eliminar</button>
            </div>
        </div>
    `).join('');
}

// Update participant checkboxes
function updateParticipantCheckboxes() {
    const container = document.getElementById('participantCheckboxes');
    if (appData.members.length === 0) {
        container.innerHTML = '<p style="color: #6c7293;">Agrega miembros primero</p>';
        return;
    }
    
    container.innerHTML = appData.members.map(m => `
        <label class="checkbox-label">
            <input type="checkbox" value="${m.id}" class="participant-check">
            <span>${m.name}${m.isSalvager ? 'Salvager' : ''}</span>
        </label>
    `).join('');
}

// Select all participants
function selectAllParticipants() {
    logAction('SITE_SELECT_ALL_PARTICIPANTS');
    document.querySelectorAll('.participant-check').forEach(cb => cb.checked = true);
}

// Deselect all participants
function deselectAllParticipants() {
    logAction('SITE_DESELECT_ALL_PARTICIPANTS');
    document.querySelectorAll('.participant-check').forEach(cb => cb.checked = false);
}

// Clear site form
function clearSiteForm() {
    logAction('SITE_FORM_CLEAR');
    document.getElementById('siteName').value = '';
    document.getElementById('siteLevel').value = '1';
    document.querySelectorAll('.participant-check').forEach(cb => cb.checked = false);
}

// Add site
function addSite() {
    logAction('SITE_ADD_ATTEMPT');
    
    const name = document.getElementById('siteName').value.trim();
    const level = parseInt(document.getElementById('siteLevel').value);
    
    if (!name) {
        logAction('SITE_ADD_VALIDATION_FAILED', { reason: 'empty_name' });
        alert('Ingresa un nombre para el sitio');
        return;
    }
    
    if (level < 1 || level > 10) {
        logAction('SITE_ADD_VALIDATION_FAILED', { reason: 'invalid_level', level });
        alert('El nivel debe estar entre 1 y 10');
        return;
    }
    
    const participantIds = Array.from(document.querySelectorAll('.participant-check:checked'))
        .map(cb => cb.value);
    
    if (participantIds.length === 0) {
        logAction('SITE_ADD_VALIDATION_FAILED', { reason: 'no_participants' });
        alert('Selecciona al menos un participante');
        return;
    }
    
    const siteData = {
        id: Date.now(),
        name,
        level,
        participants: participantIds
    };
    
    logAction('SITE_ADD_SUCCESS', { 
        siteName: name, 
        level, 
        participantCount: participantIds.length 
    });
    
    appData.sites.push(siteData);
    
    clearSiteForm();
    saveData();
    updateSitesList();
    updateBadges();
    showMessage('Sitio registrado correctamente');
}

// Remove site
function removeSite(id) {
    logAction('SITE_REMOVE_ATTEMPT', { siteId: id });
    
    const site = appData.sites.find(s => s.id === id);
    if (!confirm(`¿Eliminar el sitio "${site?.name || 'este sitio'}"?`)) {
        logAction('SITE_REMOVE_CANCELLED', { siteId: id });
        return;
    }
    
    logAction('SITE_REMOVE_CONFIRMED', { siteId: id, siteName: site?.name });
    appData.sites = appData.sites.filter(s => s.id !== id);
    saveData();
    updateSitesList();
    updateBadges();
}

// Clear all sites
function clearAllSites() {
    logAction('SITE_CLEAR_ALL_ATTEMPT');
    
    if (!confirm('¿Estás seguro de eliminar TODOS los sitios? Esta acción no se puede deshacer.')) {
        logAction('SITE_CLEAR_ALL_CANCELLED');
        return;
    }
    
    logAction('SITE_CLEAR_ALL_CONFIRMED', { siteCount: appData.sites.length });
    appData.sites = [];
    saveData();
    updateSitesList();
    updateBadges();
    showMessage('Todos los sitios han sido eliminados');
}

// Update sites list UI (FIXED - uses formatNumber for display)
function updateSitesList() {
    const container = document.getElementById('sitesList');
    const totalSites = appData.sites.length;
    document.getElementById('siteCount').textContent = totalSites;
    
    if (totalSites === 0) {
        container.innerHTML = '<div class="empty-state"><p>No hay sitios registrados</p><p style="font-size: 0.9em; margin-top: 10px;">Registra sitios para comenzar a calcular pagos</p></div>';
        return;
    }
    
    container.innerHTML = `
        <table>
            <thead>
                <tr>
                    <th>Sitio</th>
                    <th>Nivel</th>
                    <th>Participantes</th>
                    <th>Valor</th>
                    <th>Acción</th>
                </tr>
            </thead>
            <tbody>
                ${appData.sites.map(s => {
                    const participantNames = s.participants.map(pid => {
                        const member = appData.members.find(m => m.id === pid);
                        return member ? member.name : 'Desconocido';
                    }).join(', ');
                    const levelValue = appData.config.levelValues[s.level] || 0;
                    const levelName = (appData.config.levelNames && appData.config.levelNames[s.level]) ? appData.config.levelNames[s.level] : `Nivel ${s.level}`;
                    const value = `${formatNumber(levelValue)} ${appData.config.currency || 'ISK'}`;
                    return `
                        <tr>
                            <td><strong>${s.name}</strong></td>
                            <td>${levelName}</td>
                            <td style="font-size: 0.85em;">${participantNames}</td>
                            <td>${value}</td>
                            <td><button class="btn btn-danger" onclick="removeSite(${s.id})">Eliminar</button></td>
                        </tr>
                    `;
                }).join('')}
            </tbody>
        </table>
    `;
}

// Update payments display (FIXED - uses formatNumber)
function updatePaymentsDisplay() {
    const currency = appData.config.currency || 'ISK';
    
    if (!calculations) {
        document.getElementById('totalPaid').textContent = '0 ' + currency;
        document.getElementById('totalSites').textContent = '0';
        document.getElementById('avgPerSite').textContent = '0 ' + currency;
        document.getElementById('paymentsList').innerHTML = '<div class="empty-state"><p>No hay datos de pagos</p></div>';
        return;
    }
    
    document.getElementById('totalPaid').textContent = formatNumber(calculations.totalPaid) + ' ' + currency;
    document.getElementById('totalSites').textContent = calculations.totalSites || 0;
    
    const avgPerSite = calculations.totalSites > 0 ? calculations.totalPaid / calculations.totalSites : 0;
    document.getElementById('avgPerSite').textContent = formatNumber(avgPerSite) + ' ' + currency;
    
    const paymentsList = document.getElementById('paymentsList');
    if (calculations.payments.length === 0) {
        paymentsList.innerHTML = '<div class="empty-state"><p>Sin pagos</p></div>';
        return;
    }
    
    const sortedPayments = [...calculations.payments].sort((a, b) => b.total - a.total);
    
    paymentsList.innerHTML = sortedPayments.map(p => `
        <div class="payment-item ${p.isSalvager ? 'salvager' : ''}">
            <div class="payment-name">${p.name}${p.isSalvager ? 'Salvager' : ''}</div>
            <div style="color: #9ca3b8; font-size: 0.85em;">${p.sitesCount} sitio(s)</div>
            <div class="payment-amount">${formatNumber(p.total)} ${currency}</div>
        </div>
    `).join('');
}

// Export data to JSON file
async function exportData() {
    logAction('DATA_EXPORT_ATTEMPT');
    
    try {
        const response = await fetch('/api/export');
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        
        const data = await response.json();
        const dataStr = JSON.stringify(data, null, 2);
        const dataBlob = new Blob([dataStr], { type: 'application/json' });
        
        const url = URL.createObjectURL(dataBlob);
        const link = document.createElement('a');
        link.href = url;
        
        const date = new Date().toISOString().split('T')[0];
        link.download = `export${date}.json`;
        
        link.click();
        URL.revokeObjectURL(url);
        
        logAction('DATA_EXPORT_SUCCESS', { filename: link.download });
        showMessage('Datos exportados correctamente');
    } catch (error) {
        logAction('DATA_EXPORT_ERROR', { error: error.message });
        console.error('Error exporting data:', error);
        showMessage('Error al exportar datos', 'error');
    }
}

// Import data from JSON file
function importData() {
    logAction('DATA_IMPORT_ATTEMPT');
    const fileInput = document.getElementById('importFile');
    fileInput.click();
}

// Handle file import
function handleFileImport(event) {
    const file = event.target.files[0];
    
    if (!file) {
        logAction('DATA_IMPORT_CANCELLED', { reason: 'no_file' });
        return;
    }
    
    logAction('DATA_IMPORT_FILE_SELECTED', { 
        filename: file.name, 
        size: file.size,
        type: file.type 
    });
    
    if (file.type !== 'application/json') {
        logAction('DATA_IMPORT_VALIDATION_FAILED', { reason: 'invalid_type', type: file.type });
        alert('Por favor selecciona un archivo JSON válido');
        return;
    }
    
    const reader = new FileReader();
    
    reader.onload = function(e) {
        try {
            const importedData = JSON.parse(e.target.result);
            logAction('DATA_IMPORT_PARSE_SUCCESS');
            
            if (!importedData.config || !importedData.members || !importedData.sites) {
                throw new Error('Estructura de datos inválida');
            }
            
            if (!confirm('¿Importar estos datos? Esto sobrescribirá todos los datos actuales.')) {
                logAction('DATA_IMPORT_CANCELLED', { reason: 'user_cancelled' });
                return;
            }
            
            logAction('DATA_IMPORT_CONFIRMED', {
                memberCount: importedData.members.length,
                siteCount: importedData.sites.length
            });
            
            appData.config = importedData.config;
            appData.members = importedData.members;
            appData.sites = importedData.sites;
            
            saveData();
            renderAll();
            showMessage('Datos importados correctamente');
            
            logAction('DATA_IMPORT_SUCCESS');
        } catch (error) {
            logAction('DATA_IMPORT_ERROR', { error: error.message });
            console.error('Error importing data:', error);
            alert('Error al importar datos: ' + error.message);
        }
    };
    
    reader.onerror = function() {
        logAction('DATA_IMPORT_READ_ERROR');
        alert('Error al leer el archivo');
    };
    
    reader.readAsText(file);
    event.target.value = '';
}

// Set number format
function setNumberFormat(format) {
    logAction('CONFIG_SET_NUMBER_FORMAT', { format });
    appData.config.numberFormat = format;
    
    document.querySelectorAll('.format-option').forEach(opt => {
        opt.classList.remove('active');
    });
    document.querySelector(`.format-option[data-format="${format}"]`).classList.add('active');
    
    renderLevelValues();
    updateSitesList();
    updatePaymentsDisplay();
    saveData();
    showMessage('Formato de números actualizado');
}

// Set up all event listeners
function setupEventListeners() {
    logAction('EVENT_LISTENERS_SETUP_START');
    
    // Tab switching
    document.querySelectorAll('.tab').forEach(tab => {
        tab.addEventListener('click', function() {
            const tabName = this.getAttribute('data-tab');
            showTab(tabName);
        });
    });
    
    // Configuration
    document.getElementById('saveConfigBtn').addEventListener('click', saveConfig);
    document.getElementById('resetLevelsBtn').addEventListener('click', resetLevels);
    document.getElementById('autoCalculate').addEventListener('change', saveConfig);
    document.getElementById('hasSalvager').addEventListener('change', updateSalvagerSettings);
    
    // Import/Export
    document.getElementById('exportBtn').addEventListener('click', exportData);
    document.getElementById('importBtn').addEventListener('click', importData);
    document.getElementById('importFile').addEventListener('change', handleFileImport);
    
    // Number format options
    document.querySelectorAll('.format-option').forEach(opt => {
        opt.addEventListener('click', function() {
            setNumberFormat(this.getAttribute('data-format'));
        });
    });
    
    // Members
    document.getElementById('memberForm').addEventListener('submit', addMember);
    
    // Sites
    document.getElementById('selectAllBtn').addEventListener('click', selectAllParticipants);
    document.getElementById('deselectAllBtn').addEventListener('click', deselectAllParticipants);
    document.getElementById('addSiteBtn').addEventListener('click', addSite);
    document.getElementById('clearSiteFormBtn').addEventListener('click', clearSiteForm);
    document.getElementById('clearAllSitesBtn').addEventListener('click', clearAllSites);
    
    // Error modal close button
    const errorModal = document.getElementById('errorModal');
    if (errorModal) {
        const closeBtn = errorModal.querySelector('.error-modal-close');
        if (closeBtn) {
            closeBtn.addEventListener('click', closeErrorModal);
        }
        errorModal.addEventListener('click', function(e) {
            if (e.target === this) closeErrorModal();
        });
    }
    
    logAction('EVENT_LISTENERS_SETUP_COMPLETE');
}

// Initialize application
document.addEventListener('DOMContentLoaded', async function() {
    logAction('APP_INITIALIZATION_START');    
    await loadCSRFToken();
    setupEventListeners();
    loadData();
    
    logAction('APP_INITIALIZATION_COMPLETE');
});

// Log page unload
window.addEventListener('beforeunload', function() {
    logAction('APP_SESSION_END');
});