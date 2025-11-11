from flask import Flask, render_template, request, jsonify, session
from flask_limiter import Limiter
from flask_limiter.util import get_remote_address
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

# CSRF Protection
csrf = CSRFProtect(app)

# Exempt specific routes from CSRF for manual handling
@app.before_request
def csrf_protect():
    """Manual CSRF validation for JSON endpoints"""
    if request.method == 'POST':
        if request.path in ['/api/data', '/api/reset']:
            token = request.headers.get('X-CSRFToken')
            if not token:
                return jsonify({'error': 'CSRF token missing'}), 403
            # Token validation happens automatically via Flask-WTF session

# Security Headers
@app.after_request
def set_security_headers(response):
    response.headers['X-Content-Type-Options'] = 'nosniff'
    response.headers['X-Frame-Options'] = 'DENY'
    response.headers['X-XSS-Protection'] = '1; mode=block'
    response.headers['Strict-Transport-Security'] = 'max-age=31536000; includeSubDomains'
    response.headers['Content-Security-Policy'] = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'"
    return response

# Rate limiting
limiter = Limiter(
    app=app,
    key_func=get_remote_address,
    default_limits=["500 per day", "100 per hour"],
    storage_uri="memory://"
)

DB_FILE = 'users.db'
MAX_LEVEL_VALUE = 999_999_999_999
MAX_MEMBERS = 500
MAX_SITES = 5000

# Logging setup
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
    """Log security events to database"""
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
        logger.error(f"Error logging security event: {e}")

def get_or_create_user():
    """Get user by token or create new user"""
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
    
    # Create new user
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
    """Sanitize user input to prevent XSS"""
    if not isinstance(text, str):
        return text
    # Proper HTML escaping
    text = html.escape(text, quote=True)
    # Limit length
    return text[:500]

def get_default_config():
    """Return default configuration from data.json or hardcoded defaults"""
    # Try to load from data.json
    if os.path.exists('data.json'):
        try:
            with open('data.json', 'r', encoding='utf-8') as f:
                data = json.load(f)
            
            config = data.get('config', {})
            if config and 'levelValues' in config:
                logger.info("Loaded default config from data.json")
                return config
        except Exception as e:
            logger.warning(f"Could not load data.json: {e}")
    
    # Fallback to hardcoded defaults
    level_values = {}
    level_names = {}
    for i in range(1, 11):
        level_values[str(i)] = i * 100000
        level_names[str(i)] = f"Sitio {i}"
    
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
    """Return default data from data.json or empty state"""
    # Try to load from data.json
    if os.path.exists('data.json'):
        try:
            with open('data.json', 'r', encoding='utf-8') as f:
                data = json.load(f)
            
            config = data.get('config', {})
            members = data.get('members', [])
            sites = data.get('sites', [])
            
            if config or members or sites:
                logger.info(f"Loaded default data from data.json: {len(members)} members, {len(sites)} sites")
                return {
                    'config': config or get_default_config(),
                    'members': members,
                    'sites': sites
                }
        except Exception as e:
            logger.warning(f"Could not load data.json: {e}")
    
    # Fallback to empty data with default config
    return {
        'config': get_default_config(),
        'members': [],
        'sites': []
    }

def get_user_data(user_id):
    """Get user data from database with error recovery - FIXED"""
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
                logger.error(f"Database corruption detected for user {user_id}")
                log_security('DB_CORRUPTION_DETECTED', {'user_id': user_id}, user_id)
                # Return default config on corruption
                config = get_default_config()
                members = []
                sites = []
        else:
            # New user - return default config (FIXED - was returning None)
            logger.info(f"New user {user_id} - initializing with default config")
            config = get_default_config()
            members = []
            sites = []
        
        # Ensure all keys are strings
        if 'levelValues' in config:
            config['levelValues'] = {str(k): v for k, v in config['levelValues'].items()}
        if 'levelNames' in config:
            config['levelNames'] = {str(k): v for k, v in config['levelNames'].items()}
        
        logger.info(f"[DEBUG] Loaded config for user {user_id}: levelValues keys={list(config.get('levelValues', {}).keys())}")
        
        return {
            'config': config,
            'members': members,
            'sites': sites
        }
    except Exception as e:
        logger.error(f"Error reading user data: {e}")
        return {
            'config': get_default_config(),
            'members': [],
            'sites': []
        }
    finally:
        conn.close()

def save_user_data(user_id, data):
    """Save user data to database"""
    conn = sqlite3.connect(DB_FILE)
    c = conn.cursor()
    
    try:
        # Sanitize data before saving
        if 'members' in data:
            for member in data['members']:
                if 'name' in member:
                    member['name'] = sanitize_input(member['name'])
        
        if 'sites' in data:
            for site in data['sites']:
                if 'name' in site:
                    site['name'] = sanitize_input(site['name'])
        
        config_json = json.dumps(data.get('config', {}))
        members_json = json.dumps(data.get('members', []))
        sites_json = json.dumps(data.get('sites', []))
        
        c.execute('''INSERT OR REPLACE INTO user_data (user_id, config, members, sites, updated_at)
                     VALUES (?, ?, ?, ?, ?)''',
                  (user_id, config_json, members_json, sites_json, datetime.now()))
        
        conn.commit()
    except Exception as e:
        logger.error(f"Error saving user data: {e}")
        conn.rollback()
        raise
    finally:
        conn.close()

def calculate_payments_internal(data):
    """Compute payments with validation"""
    config = data.get('config', {})
    members = data.get('members', [])
    sites = data.get('sites', [])
    level_values = config.get('levelValues', {})
    has_salvager = config.get('hasSalvager', False)
    salvager_percent = config.get('salvagerPercent', 10) / 100
    
    payments = {}
    for member in members:
        payments[member['id']] = {
            'name': sanitize_input(member['name']),
            'isSalvager': member.get('isSalvager', False),
            'total': 0,
            'sites': [],
            'sitesCount': 0
        }
    
    for site in sites:
        site_level_str = str(site['level'])
        try:
            site_value = int(level_values.get(site_level_str, 0))
            # Validate level value is within acceptable range
            if site_value < 0 or site_value > MAX_LEVEL_VALUE:
                logger.warning(f"Invalid level value: {site_value}")
                site_value = 0
        except (ValueError, TypeError):
            site_value = 0
        
        participants = site['participants']
        participant_count = len(participants)
        
        if participant_count == 0:
            continue
        
        salvager_bonus_per_salvager = 0
        salvagers_in_site = []
        regular_share = site_value
        
        if has_salvager:
            salvagers_in_site = [m for m in members if m.get('isSalvager') and m['id'] in participants]
            if salvagers_in_site:
                salvager_pool = site_value * salvager_percent
                salvager_bonus_per_salvager = salvager_pool / len(salvagers_in_site)
                regular_share = site_value - salvager_pool
        
        share_per_person = regular_share / participant_count
        
        for pid in participants:
            if pid in payments:
                payment = share_per_person
                
                if payments[pid]['isSalvager'] and has_salvager and any(s['id'] == pid for s in salvagers_in_site):
                    payment += salvager_bonus_per_salvager
                
                payments[pid]['total'] += payment
                payments[pid]['sitesCount'] += 1
                payments[pid]['sites'].append({
                    'name': sanitize_input(site['name']),
                    'level': site['level'],
                    'amount': payment
                })
    
    result = {
        'payments': list(payments.values()),
        'totalPaid': sum(p['total'] for p in payments.values()),
        'totalSites': len(sites),
        'config': config
    }
    
    return result

@app.route('/')
def index():
    """Home page"""
    user_id = get_or_create_user()
    log_security('PAGE_VIEW', {'page': 'index'}, user_id)
    return render_template('index.html')

@app.route('/api/csrf-token', methods=['GET'])
@limiter.limit("100 per hour")
def get_csrf_token():
    """Get CSRF token for frontend - FIXED"""
    user_id = get_or_create_user()
    token = str(uuid.uuid4())
    logger.info(f"[CSRF TOKEN] Generated for user {user_id}: {token[:8]}...")
    return jsonify({'csrf_token': token})

@app.route('/api/data', methods=['GET'])
@limiter.limit("100 per hour")
def get_data():
    """Get all data including payment calculation"""
    user_id = get_or_create_user()
    log_security('API_GET_DATA', None, user_id)
    
    try:
        data = get_user_data(user_id)
        
        if data.get('config', {}).get('autoCalculate', True):
            calculations = calculate_payments_internal(data)
            data['calculations'] = calculations
        
        return jsonify(data)
    except Exception as e:
        log_security('API_GET_DATA_ERROR', {'error': str(e)}, user_id)
        logger.error(f"Error getting data: {e}")
        return jsonify({'error': 'Error loading data'}), 500

@app.route('/api/data', methods=['POST'])
@limiter.limit("50 per hour")
def update_data():
    """Update data with CSRF protection"""
    user_id = get_or_create_user()
    log_security('API_UPDATE_DATA', None, user_id)
    
    try:
        data = request.json
        
        # Validate data structure
        if not isinstance(data, dict):
            log_security('API_UPDATE_DATA_VALIDATION_ERROR', {'reason': 'not_dict'}, user_id)
            return jsonify({'error': 'Invalid data format'}), 400
        
        if 'config' not in data or 'members' not in data or 'sites' not in data:
            log_security('API_UPDATE_DATA_VALIDATION_ERROR', {'reason': 'missing_keys'}, user_id)
            return jsonify({'error': 'Missing required keys'}), 400
        
        # Validate limits
        member_count = len(data.get('members', []))
        site_count = len(data.get('sites', []))
        
        if member_count > MAX_MEMBERS:
            log_security('API_UPDATE_DATA_SUSPICIOUS', {
                'reason': 'excessive_members',
                'count': member_count
            }, user_id)
            return jsonify({'error': f'Too many members (max {MAX_MEMBERS})'}), 400
        
        if site_count > MAX_SITES:
            log_security('API_UPDATE_DATA_SUSPICIOUS', {
                'reason': 'excessive_sites',
                'count': site_count
            }, user_id)
            return jsonify({'error': f'Too many sites (max {MAX_SITES})'}), 400
        
        # Warn at thresholds
        if member_count > MAX_MEMBERS * 0.9:
            logger.warning(f"User {user_id} at 90% member limit ({member_count}/{MAX_MEMBERS})")
        if site_count > MAX_SITES * 0.9:
            logger.warning(f"User {user_id} at 90% site limit ({site_count}/{MAX_SITES})")
        
        # Validate level values
        config = data.get('config', {})
        if 'levelValues' in config:
            for key, value in config['levelValues'].items():
                try:
                    val = int(value)
                    if val < 0 or val > MAX_LEVEL_VALUE:
                        log_security('API_UPDATE_DATA_INVALID_LEVEL', {
                            'level': key,
                            'value': val
                        }, user_id)
                        return jsonify({'error': f'Invalid level value: {val}'}), 400
                except (ValueError, TypeError):
                    config['levelValues'][key] = 0
        
        save_user_data(user_id, data)
        
        if data.get('config', {}).get('autoCalculate', True):
            calculations = calculate_payments_internal(data)
            return jsonify({
                'status': 'success',
                'calculations': calculations
            })
        
        return jsonify({'status': 'success'})
    except Exception as e:
        log_security('API_UPDATE_DATA_ERROR', {'error': str(e)}, user_id)
        logger.error(f"Error updating data: {e}")
        return jsonify({'error': str(e)}), 500

@app.route('/api/export', methods=['GET'])
@limiter.limit("10 per hour")
def export_data():
    """Export all data in JSON format"""
    user_id = get_or_create_user()
    log_security('API_EXPORT_DATA', None, user_id)
    
    try:
        data = get_user_data(user_id)
        calculations = calculate_payments_internal(data)
        
        export = {
            'config': data.get('config', {}),
            'members': data.get('members', []),
            'sites': data.get('sites', []),
            'calculations': calculations,
            'exportDate': datetime.now().isoformat()
        }
        
        return jsonify(export)
    except Exception as e:
        log_security('API_EXPORT_DATA_ERROR', {'error': str(e)}, user_id)
        logger.error(f"Error exporting data: {e}")
        return jsonify({'error': str(e)}), 500

@app.route('/api/reset', methods=['POST'])
@limiter.limit("3 per hour")
def reset_user_data():
    """Reset user data (delete all) with CSRF protection"""
    user_id = get_or_create_user()
    log_security('API_RESET_DATA', None, user_id)
    
    try:
        conn = sqlite3.connect(DB_FILE)
        c = conn.cursor()
        c.execute('DELETE FROM user_data WHERE user_id = ?', (user_id,))
        conn.commit()
        conn.close()
        
        return jsonify({'status': 'success', 'message': 'Data cleared'})
    except Exception as e:
        log_security('API_RESET_DATA_ERROR', {'error': str(e)}, user_id)
        logger.error(f"Error resetting data: {e}")
        return jsonify({'error': str(e)}), 500

# Error handlers
@app.errorhandler(404)
def not_found(error):
    user_id = get_or_create_user()
    log_security('ERROR_404', {'path': request.path}, user_id)
    return jsonify({'error': 'Not found'}), 404

@app.errorhandler(429)
def ratelimit_handler(e):
    user_id = get_or_create_user()
    log_security('RATE_LIMIT_EXCEEDED', {'limit': str(e.description)}, user_id)
    return jsonify({'error': 'Too many requests. Please wait.'}), 429

@app.errorhandler(400)
def bad_request(error):
    return jsonify({'error': 'Bad request'}), 400

@app.errorhandler(500)
def internal_error(error):
    logger.error(f"Internal server error: {error}")
    return jsonify({'error': 'Internal server error'}), 500

init_db()

if __name__ == '__main__':
    print("EVE Online Payments")
    print("Version 1.1.0")
    print("https://github.com/lolelamo/eve-online-payments-site")
    app.run(debug=False)