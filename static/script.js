// Application state
let appData = {
    config: {
        levelValues: {},
        hasSalvager: false,
        salvagerPercent: 10,
        currency: 'ISK',
        autoCalculate: true
    },
    members: [],
    sites: []
};

let calculations = null;
let saveTimeout = null;

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

// Load data from server
async function loadData() {
    logAction('DATA_LOAD_START');
    showLoading();
    try {
        const response = await fetch('/api/data');
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        const data = await response.json();
        logAction('DATA_LOAD_SUCCESS', { memberCount: data.members?.length, siteCount: data.sites?.length });
        appData = data;
        calculations = data.calculations || null;
        renderAll();
        updatePaymentsDisplay();
        hideLoading();
    } catch (error) {
        logAction('DATA_LOAD_ERROR', { error: error.message });
        console.error('Error cargando datos:', error);
        renderAll();
        hideLoading();
        showMessage('Error al cargar datos. Usando valores por defecto.', 'error');
    }
}

// Save data to server with debouncing
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
                    'Content-Type': 'application/json'
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
            console.error('Error guardando datos:', error);
            showMessage('Error al guardar datos', 'error');
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
    const levelValues = appData.config.levelValues || {};
    const levelNames = appData.config.levelNames || {};
    
    for (let i = 1; i <= 10; i++) {
        const div = document.createElement('div');
        div.className = 'level-card';
        const nameVal = levelNames[i] || `Nivel ${i}`;
        const amountVal = levelValues[i] || i * 100000;
        div.innerHTML = `
            <label>Nivel ${i}</label>
            <input type="text" id="levelName${i}" value="${nameVal}" placeholder="Nombre del nivel">
            <input type="number" id="level${i}" value="${amountVal}" min="0" step="10000" placeholder="Valor en ISK">
        `;
        container.appendChild(div);
    }
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
        document.getElementById(`level${i}`).value = i * 100000;
        document.getElementById(`levelName${i}`).value = `Nivel ${i}`;
    }
    
    showMessage('Valores restaurados a los predeterminados');
}

// Save configuration
function saveConfig() {
    logAction('CONFIG_SAVE_START');
    
    for (let i = 1; i <= 10; i++) {
        appData.config.levelValues[i] = parseInt(document.getElementById(`level${i}`).value) || 0;
        const ln = (document.getElementById(`levelName${i}`) || { value: `Nivel ${i}` }).value.trim();
        if (!appData.config.levelNames) appData.config.levelNames = {};
        appData.config.levelNames[i] = ln || `Nivel ${i}`;
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

// Add member(s)
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
            id: Date.now() + Math.floor(Math.random()*1000) 
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
                <button class="btn btn-danger" onclick="removeMember(${m.id})">Eliminar</button>
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
            <span>${m.name}${m.isSalvager ? ' ⭐' : ''}</span>
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
        .map(cb => parseInt(cb.value));
    
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

// Update sites list UI
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
                    const value = `${levelValue.toLocaleString()} ${appData.config.currency || 'ISK'}`;
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

// Update payments display
function updatePaymentsDisplay() {
    const currency = appData.config.currency || 'ISK';
    
    if (!calculations) {
        document.getElementById('totalPaid').textContent = '0 ' + currency;
        document.getElementById('totalSites').textContent = '0';
        document.getElementById('avgPerSite').textContent = '0 ' + currency;
        document.getElementById('paymentsList').innerHTML = '<div class="empty-state"><p>No hay datos de pagos</p></div>';
        return;
    }
    
    document.getElementById('totalPaid').textContent = Math.round(calculations.totalPaid).toLocaleString() + ' ' + currency;
    document.getElementById('totalSites').textContent = calculations.totalSites || 0;
    
    const avgPerSite = calculations.totalSites > 0 ? calculations.totalPaid / calculations.totalSites : 0;
    document.getElementById('avgPerSite').textContent = Math.round(avgPerSite).toLocaleString() + ' ' + currency;
    
    const paymentsList = document.getElementById('paymentsList');
    if (calculations.payments.length === 0) {
        paymentsList.innerHTML = '<div class="empty-state"><p>Sin pagos</p></div>';
        return;
    }
    
    // Sort by total descending
    const sortedPayments = [...calculations.payments].sort((a, b) => b.total - a.total);
    
    paymentsList.innerHTML = sortedPayments.map(p => `
        <div class="payment-item ${p.isSalvager ? 'salvager' : ''}">
            <div class="payment-name">${p.name}${p.isSalvager ? ' ⭐' : ''}</div>
            <div style="color: #9ca3b8; font-size: 0.85em;">${p.sitesCount} sitio(s)</div>
            <div class="payment-amount">${Math.round(p.total).toLocaleString()} ${currency}</div>
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
        console.error('Error exportando datos:', error);
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
            
            // Validate imported data structure
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
            
            // Update app data
            appData.config = importedData.config;
            appData.members = importedData.members;
            appData.sites = importedData.sites;
            
            // Save and re-render
            saveData();
            renderAll();
            showMessage('Datos importados correctamente');
            
            logAction('DATA_IMPORT_SUCCESS');
        } catch (error) {
            logAction('DATA_IMPORT_ERROR', { error: error.message });
            console.error('Error importando datos:', error);
            alert('Error al importar datos: ' + error.message);
        }
    };
    
    reader.onerror = function() {
        logAction('DATA_IMPORT_READ_ERROR');
        alert('Error al leer el archivo');
    };
    
    reader.readAsText(file);
    
    // Reset input
    event.target.value = '';
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
    
    // Members
    document.getElementById('memberForm').addEventListener('submit', addMember);
    
    // Sites
    document.getElementById('selectAllBtn').addEventListener('click', selectAllParticipants);
    document.getElementById('deselectAllBtn').addEventListener('click', deselectAllParticipants);
    document.getElementById('addSiteBtn').addEventListener('click', addSite);
    document.getElementById('clearSiteFormBtn').addEventListener('click', clearSiteForm);
    document.getElementById('clearAllSitesBtn').addEventListener('click', clearAllSites);
    
    logAction('EVENT_LISTENERS_SETUP_COMPLETE');
}

// Initialize application
document.addEventListener('DOMContentLoaded', function() {
    logAction('APP_INITIALIZATION_START');
    console.log('%c⚠️ SECURITY LOG ENABLED ⚠️', 'color: #ff6b6b; font-size: 16px; font-weight: bold;');
    console.log('%cTodas las acciones del usuario están siendo registradas para seguridad.', 'color: #ffc107; font-size: 12px;');
    
    setupEventListeners();
    loadData();
    
    logAction('APP_INITIALIZATION_COMPLETE');
});

// Log page unload
window.addEventListener('beforeunload', function() {
    logAction('APP_SESSION_END');
});