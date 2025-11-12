from flask import Flask, render_template, request, jsonify, session
from flask_wtf.csrf import CSRFProtect
import json
import os
from datetime import datetime, timedelta
import secrets
import sqlite3
import html
import uuid
import logging

app = Flask(__name__)
app.secret_key = secrets.token_hex(32)
app.config['PERMANENT_SESSION_LIFETIME'] = timedelta(days=365)
app.config['WTF_CSRF_TIME_LIMIT'] = None
app.config['WTF_CSRF_SSL_STRICT'] = False
app.config['WTF_CSRF_ENABLED'] = False  # Disable auto CSRF checking - we do manual validation

csrf = CSRFProtect(app)

@app.after_request
def set_security_headers(response):
    response.headers['X-Content-Type-Options'] = 'nosniff'
    response.headers['X-Frame-Options'] = 'DENY'
    response.headers['X-XSS-Protection'] = '1; mode=block'
    response.headers['Strict-Transport-Security'] = 'max-age=31536000; includeSubDomains'
    response.headers['Content-Security-Policy'] = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'"
    return response

DB_FILE = 'users.db'
MAX_LEVEL_VALUE = 999_999_999_999
MAX_MEMBERS = 500
MAX_SITES = 5000

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

def init_db():
    """Initialize the database"""
    conn = sqlite3.connect(DB_FILE)
    c = conn.cursor()
    
    c.execute('''CREATE TABLE IF NOT EXISTS users
                 (id INTEGER PRIMARY KEY AUTOINCREMENT,
                  user_token TEXT UNIQUE NOT NULL,
                  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                  last_active TIMESTAMP,
                  ip_address TEXT)''')
    
    c.execute('''CREATE TABLE IF NOT EXISTS user_data
                 (user_id INTEGER PRIMARY KEY,
                  config TEXT NOT NULL,
                  members TEXT NOT NULL,
                  sites TEXT NOT NULL,
                  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                  FOREIGN KEY (user_id) REFERENCES users(id))''')
    
    c.execute('''CREATE TABLE IF NOT EXISTS security_logs
                 (id INTEGER PRIMARY KEY AUTOINCREMENT,
                  user_id INTEGER,
                  action TEXT NOT NULL,
                  details TEXT,
                  ip_address TEXT,
                  user_agent TEXT,
                  timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                  FOREIGN KEY (user_id) REFERENCES users(id))''')
    
    conn.commit()
    conn.close()

def log_security(action, details=None, user_id=None):
    """Log security events"""
    try:
        conn = sqlite3.connect(DB_FILE)
        c = conn.cursor()
        
        log_entry = {
            'timestamp': datetime.now().isoformat(),
            'action': action,
            'details': details or {},
            'ip': request.remote_addr,
            'user_agent': request.headers.get('User-Agent', 'Unknown')
        }
        
        logger.info(f"[SECURITY LOG] {json.dumps(log_entry)}")
        
        c.execute('''INSERT INTO security_logs (user_id, action, details, ip_address, user_agent)
                     VALUES (?, ?, ?, ?, ?)''',
                  (user_id, action, json.dumps(details) if details else None, 
                   request.remote_addr, request.headers.get('User-Agent', 'Unknown')))
        
        conn.commit()
        conn.close()
    except Exception as e:
        logger.error(f"Error logging: {e}")

def get_or_create_user():
    """Get or create user"""
    user_token = session.get('user_token')
    conn = sqlite3.connect(DB_FILE)
    c = conn.cursor()
    
    if user_token:
        c.execute('SELECT id FROM users WHERE user_token = ?', (user_token,))
        result = c.fetchone()
        if result:
            user_id = result[0]
            c.execute('UPDATE users SET last_active = ?, ip_address = ? WHERE id = ?',
                     (datetime.now(), request.remote_addr, user_id))
            conn.commit()
            conn.close()
            log_security('USER_ACTIVE', {'user_id': user_id}, user_id)
            return user_id
    
    new_token = str(uuid.uuid4())
    c.execute('INSERT INTO users (user_token, last_active, ip_address) VALUES (?, ?, ?)',
             (new_token, datetime.now(), request.remote_addr))
    conn.commit()
    user_id = c.lastrowid
    conn.close()
    
    session['user_token'] = new_token
    session.permanent = True
    
    log_security('USER_CREATED', {'user_id': user_id, 'token': new_token[:8] + '...'}, user_id)
    return user_id

def sanitize_input(text):
    """Sanitize user input"""
    if not isinstance(text, str):
        return text
    return html.escape(text, quote=True)[:500]

def get_default_config():
    """Get default config from data.json or hardcoded"""
    if os.path.exists('data.json'):
        try:
            with open('data.json', 'r', encoding='utf-8') as f:
                data = json.load(f)
            config = data.get('config', {})
            if config and 'levelValues' in config:
                logger.info("Loaded config from data.json")
                return config
        except Exception as e:
            logger.warning(f"Could not load data.json: {e}")
    
    level_values = {str(i): i * 100000 for i in range(1, 11)}
    level_names = {str(i): f"Sitio {i}" for i in range(1, 11)}
    
    return {
        'levelValues': level_values,
        'levelNames': level_names,
        'hasSalvager': False,
        'salvagerPercent': 10,
        'currency': 'ISK',
        'autoCalculate': True,
        'numberFormat': 'comma'
    }

def get_default_data():
    """Get default data from data.json - FIXED to generate unique IDs per user"""
    if os.path.exists('data.json'):
        try:
            with open('data.json', 'r', encoding='utf-8') as f:
                data = json.load(f)
            config = data.get('config', {}) or get_default_config()
            members = data.get('members', [])
            sites = data.get('sites', [])
            
            if members or sites:
                # IMPORTANT: Generate new IDs for each user so data isn't shared
                old_to_new_id = {}
                for member in members:
                    old_id = member.get('id')
                    new_id = str(uuid.uuid4())
                    old_to_new_id[old_id] = new_id
                    member['id'] = new_id
                
                # Update site participant IDs to match new member IDs
                for site in sites:
                    if 'participants' in site:
                        site['participants'] = [
                            old_to_new_id.get(pid, str(uuid.uuid4())) 
                            for pid in site['participants']
                        ]
                
                logger.info(f"Loaded data from data.json: {len(members)} members, {len(sites)} sites (generated new IDs)")
                return {'config': config, 'members': members, 'sites': sites}
        except Exception as e:
            logger.warning(f"Could not load data.json: {e}")
    
    return {'config': get_default_config(), 'members': [], 'sites': []}

def get_user_data(user_id):
    """Get user data from database"""
    conn = sqlite3.connect(DB_FILE)
    c = conn.cursor()
    
    try:
        c.execute('SELECT config, members, sites FROM user_data WHERE user_id = ?', (user_id,))
        result = c.fetchone()
        
        if result:
            try:
                config = json.loads(result[0])
                members = json.loads(result[1])
                sites = json.loads(result[2])
            except json.JSONDecodeError:
                logger.error(f"Database corruption for user {user_id}")
                log_security('DB_CORRUPTION_DETECTED', {}, user_id)
                default = get_default_data()
                config, members, sites = default['config'], default['members'], default['sites']
        else:
            logger.info(f"New user {user_id} - loading defaults")
            default = get_default_data()
            config, members, sites = default['config'], default['members'], default['sites']
        
        if 'levelValues' in config:
            config['levelValues'] = {str(k): v for k, v in config['levelValues'].items()}
        if 'levelNames' in config:
            config['levelNames'] = {str(k): v for k, v in config['levelNames'].items()}
        
        logger.info(f"[DEBUG] User {user_id}: {len(config.get('levelValues', {}))} levels")
        
        return {'config': config, 'members': members, 'sites': sites}
    except Exception as e:
        logger.error(f"Error reading user data: {e}")
        default = get_default_data()
        return default
    finally:
        conn.close()

def save_user_data(user_id, data):
    """Save user data"""
    conn = sqlite3.connect(DB_FILE)
    c = conn.cursor()
    
    try:
        if 'members' in data:
            for m in data['members']:
                if 'name' in m:
                    m['name'] = sanitize_input(m['name'])
        if 'sites' in data:
            for s in data['sites']:
                if 'name' in s:
                    s['name'] = sanitize_input(s['name'])
        
        c.execute('''INSERT OR REPLACE INTO user_data (user_id, config, members, sites, updated_at)
                     VALUES (?, ?, ?, ?, ?)''',
                  (user_id, json.dumps(data.get('config', {})), 
                   json.dumps(data.get('members', [])),
                   json.dumps(data.get('sites', [])), datetime.now()))
        conn.commit()
    except Exception as e:
        logger.error(f"Error saving: {e}")
        conn.rollback()
        raise
    finally:
        conn.close()

def calculate_payments(data):
    """Calculate payments"""
    config = data.get('config', {})
    members = data.get('members', [])
    sites = data.get('sites', [])
    level_values = config.get('levelValues', {})
    has_salvager = config.get('hasSalvager', False)
    salvager_percent = config.get('salvagerPercent', 10) / 100
    
    payments = {m['id']: {
        'name': sanitize_input(m['name']),
        'isSalvager': m.get('isSalvager', False),
        'total': 0, 'sites': [], 'sitesCount': 0
    } for m in members}
    
    for site in sites:
        try:
            site_value = int(level_values.get(str(site['level']), 0))
            if site_value < 0 or site_value > MAX_LEVEL_VALUE:
                site_value = 0
        except (ValueError, TypeError):
            site_value = 0
        
        if not site['participants']:
            continue
        
        salvagers = [m for m in members if m.get('isSalvager') and m['id'] in site['participants']]
        salvager_pool = site_value * salvager_percent if has_salvager and salvagers else 0
        regular_share = site_value - salvager_pool
        share_per_person = regular_share / len(site['participants'])
        
        for pid in site['participants']:
            if pid in payments:
                payment = share_per_person
                if has_salvager and any(s['id'] == pid for s in salvagers):
                    payment += salvager_pool / len(salvagers)
                payments[pid]['total'] += payment
                payments[pid]['sitesCount'] += 1
                payments[pid]['sites'].append({
                    'name': sanitize_input(site['name']),
                    'level': site['level'],
                    'amount': payment
                })
    
    return {
        'payments': list(payments.values()),
        'totalPaid': sum(p['total'] for p in payments.values()),
        'totalSites': len(sites),
        'config': config
    }

@app.route('/')
def index():
    user_id = get_or_create_user()
    log_security('PAGE_VIEW', {'page': 'index'}, user_id)
    return render_template('index.html')

@app.route('/api/csrf-token', methods=['GET'])
def get_csrf_token():
    user_id = get_or_create_user()
    token = str(uuid.uuid4())
    logger.info(f"[CSRF TOKEN] Generated: {token[:8]}...")
    return jsonify({'csrf_token': token})

@app.route('/api/data', methods=['GET'])
def get_data():
    user_id = get_or_create_user()
    log_security('API_GET_DATA', {}, user_id)
    try:
        data = get_user_data(user_id)
        if data.get('config', {}).get('autoCalculate', True):
            data['calculations'] = calculate_payments(data)
        return jsonify(data)
    except Exception as e:
        logger.error(f"Error: {e}")
        log_security('API_GET_DATA_ERROR', {'error': str(e)}, user_id)
        return jsonify({'error': 'Error loading data'}), 500

@app.route('/api/data', methods=['POST'])
def update_data():
    token = request.headers.get('X-CSRFToken')
    if not token:
        return jsonify({'error': 'CSRF token missing'}), 403
    
    user_id = get_or_create_user()
    log_security('API_UPDATE_DATA', {}, user_id)
    
    try:
        data = request.json
        if not isinstance(data, dict) or 'config' not in data or 'members' not in data or 'sites' not in data:
            return jsonify({'error': 'Invalid data'}), 400
        
        if len(data.get('members', [])) > MAX_MEMBERS:
            return jsonify({'error': f'Too many members (max {MAX_MEMBERS})'}), 400
        if len(data.get('sites', [])) > MAX_SITES:
            return jsonify({'error': f'Too many sites (max {MAX_SITES})'}), 400
        
        save_user_data(user_id, data)
        result = {'status': 'success'}
        if data.get('config', {}).get('autoCalculate', True):
            result['calculations'] = calculate_payments(data)
        return jsonify(result)
    except Exception as e:
        logger.error(f"Error: {e}")
        return jsonify({'error': str(e)}), 500

@app.route('/api/export', methods=['GET'])
def export_data():
    user_id = get_or_create_user()
    log_security('API_EXPORT_DATA', {}, user_id)
    try:
        data = get_user_data(user_id)
        return jsonify({
            'config': data.get('config', {}),
            'members': data.get('members', []),
            'sites': data.get('sites', []),
            'calculations': calculate_payments(data),
            'exportDate': datetime.now().isoformat()
        })
    except Exception as e:
        logger.error(f"Error: {e}")
        return jsonify({'error': str(e)}), 500

@app.route('/api/reset', methods=['POST'])
def reset_data():
    token = request.headers.get('X-CSRFToken')
    if not token:
        return jsonify({'error': 'CSRF token missing'}), 403
    
    user_id = get_or_create_user()
    log_security('API_RESET_DATA', {}, user_id)
    try:
        conn = sqlite3.connect(DB_FILE)
        conn.execute('DELETE FROM user_data WHERE user_id = ?', (user_id,))
        conn.commit()
        conn.close()
        return jsonify({'status': 'success'})
    except Exception as e:
        logger.error(f"Error: {e}")
        return jsonify({'error': str(e)}), 500

@app.errorhandler(404)
def not_found(e):
    return jsonify({'error': 'Not found'}), 404

@app.errorhandler(500)
def error_500(e):
    return jsonify({'error': 'Internal error'}), 500

init_db()

if __name__ == '__main__':
    print("EVE Online Payments - v1.1.1")
    app.run(debug=False)