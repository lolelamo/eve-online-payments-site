from flask import Flask, render_template, request, jsonify
import json
import os
from datetime import datetime
import time as tm
app = Flask(__name__)

# Configuration and data file
DATA_FILE = 'data.json'

def log_action(action, details=None):
    """Log actions for security monitoring"""
    timestamp = datetime.now().isoformat()
    log_entry = {
        'timestamp': timestamp,
        'action': action,
        'details': details or {},
        'ip': request.remote_addr,
        'user_agent': request.headers.get('User-Agent', 'Unknown')
    }
    print(f"[SERVER LOG] {json.dumps(log_entry)}")

def load_data():
    """Load data from the JSON file or create a default structure"""
    log_action('DATA_LOAD_ATTEMPT')
    try:
        if os.path.exists(DATA_FILE):
            with open(DATA_FILE, 'r') as f:
                data = json.load(f)
                log_action('DATA_LOAD_SUCCESS', {'has_data': True})
                return data
        log_action('DATA_LOAD_SUCCESS', {'has_data': False, 'reason': 'file_not_found'})
        return {
            'config': {
                'levelValues': {str(i): i * 100000 for i in range(1, 11)},
                'levelNames': {str(i): f'Nivel {i}' for i in range(1, 11)},
                'hasSalvager': False,
                'salvagerPercent': 10,
                'currency': 'ISK',
                'autoCalculate': True
            },
            'members': [],
            'sites': []
        }
    except Exception as e:
        log_action('DATA_LOAD_ERROR', {'error': str(e)})
        raise

def save_data(data):
    """Save data to the JSON file"""
    log_action('DATA_SAVE_ATTEMPT', {
        'member_count': len(data.get('members', [])),
        'site_count': len(data.get('sites', []))
    })
    try:
        with open(DATA_FILE, 'w') as f:
            json.dump(data, f, indent=2, ensure_ascii=False)
        log_action('DATA_SAVE_SUCCESS')
    except Exception as e:
        log_action('DATA_SAVE_ERROR', {'error': str(e)})
        raise

def calculate_payments_internal(data):
    """Compute payments based on the provided data"""
    log_action('CALCULATION_START')
    
    config = data.get('config', {})
    members = data.get('members', [])
    sites = data.get('sites', [])
    level_values = config.get('levelValues', {})
    has_salvager = config.get('hasSalvager', False)
    salvager_percent = config.get('salvagerPercent', 10) / 100
    
    # Initialize payments for each member
    payments = {}
    for member in members:
        payments[member['id']] = {
            'name': member['name'],
            'isSalvager': member.get('isSalvager', False),
            'total': 0,
            'sites': [],
            'sitesCount': 0
        }
    
    # Process each site (removed level 99 check - all sites are now counted) // it had no purpose
    for site in sites:
        site_value = int(level_values.get(str(site['level']), 0))
        participants = site['participants']
        participant_count = len(participants)
        
        if participant_count == 0:
            log_action('CALCULATION_WARNING', {
                'site_id': site.get('id'),
                'reason': 'no_participants'
            })
            continue
        
        salvager_bonus_per_salvager = 0
        salvagers_in_site = []
        regular_share = site_value
        
        # Calculate salvager bonus if enabled
        if has_salvager:
            salvagers_in_site = [m for m in members if m.get('isSalvager') and m['id'] in participants]
            if salvagers_in_site:
                salvager_pool = site_value * salvager_percent
                salvager_bonus_per_salvager = salvager_pool / len(salvagers_in_site)
                regular_share = site_value - salvager_pool
        
        # calcs
        share_per_person = regular_share / participant_count
        
        # Assign payments to each participant
        for pid in participants:
            if pid in payments:
                payment = share_per_person
                
                # Add salvager bonus if applicable
                if payments[pid]['isSalvager'] and has_salvager and any(s['id'] == pid for s in salvagers_in_site):
                    payment += salvager_bonus_per_salvager
                
                payments[pid]['total'] += payment
                payments[pid]['sitesCount'] += 1
                payments[pid]['sites'].append({
                    'name': site['name'],
                    'level': site['level'],
                    'amount': payment
                })
    
    # result
    result = {
        'payments': list(payments.values()),
        'totalPaid': sum(p['total'] for p in payments.values()),
        'totalSites': len(sites),
        'config': config
    }
    
    log_action('CALCULATION_COMPLETE', {
        'total_paid': result['totalPaid'],
        'total_sites': result['totalSites'],
        'payment_count': len(result['payments'])
    })
    
    return result

@app.route('/')
def index():
    """Home page"""
    log_action('PAGE_VIEW', {'page': 'index'})
    return render_template('index.html')

@app.route('/api/data', methods=['GET'])
def get_data():
    """Get all data including payment calculation"""
    log_action('API_GET_DATA')
    try:
        data = load_data()
        
        # If autoCalculate is enabled, include calculations
        if data.get('config', {}).get('autoCalculate', True):
            calculations = calculate_payments_internal(data)
            data['calculations'] = calculations
        
        return jsonify(data)
    except Exception as e:
        log_action('API_GET_DATA_ERROR', {'error': str(e)})
        return jsonify({'error': str(e)}), 500

@app.route('/api/data', methods=['POST'])
def update_data():
    """Update data and return updated calculations"""
    log_action('API_UPDATE_DATA')
    try:
        data = request.json
        
        # Validate data structure
        if not isinstance(data, dict):
            log_action('API_UPDATE_DATA_VALIDATION_ERROR', {'reason': 'not_dict'})
            return jsonify({'error': 'Invalid data format'}), 400
        
        if 'config' not in data or 'members' not in data or 'sites' not in data:
            log_action('API_UPDATE_DATA_VALIDATION_ERROR', {'reason': 'missing_keys'})
            return jsonify({'error': 'Missing required keys'}), 400
        
        # Additional validation: check for suspicious activity
        member_count = len(data.get('members', []))
        site_count = len(data.get('sites', []))
        
        if member_count > 1000:
            log_action('API_UPDATE_DATA_SUSPICIOUS', {
                'reason': 'excessive_members',
                'count': member_count
            })
            return jsonify({'error': 'Too many members'}), 400
        
        if site_count > 10000:
            log_action('API_UPDATE_DATA_SUSPICIOUS', {
                'reason': 'excessive_sites',
                'count': site_count
            })
            return jsonify({'error': 'Too many sites'}), 400
        
        save_data(data)
        
        # Automatically calculate payments
        if data.get('config', {}).get('autoCalculate', True):
            calculations = calculate_payments_internal(data)
            return jsonify({
                'status': 'success',
                'calculations': calculations
            })
        
        return jsonify({'status': 'success'})
    except Exception as e:
        log_action('API_UPDATE_DATA_ERROR', {'error': str(e)})
        return jsonify({'error': str(e)}), 500

@app.route('/api/config', methods=['GET'])
def get_config():
    """Get only the configuration"""
    log_action('API_GET_CONFIG')
    try:
        data = load_data()
        return jsonify(data.get('config', {}))
    except Exception as e:
        log_action('API_GET_CONFIG_ERROR', {'error': str(e)})
        return jsonify({'error': str(e)}), 500

@app.route('/api/config', methods=['POST'])
def update_config():
    """Update only the configuration"""
    log_action('API_UPDATE_CONFIG')
    try:
        data = load_data()
        config = request.json
        
        # Validate config
        if not isinstance(config, dict):
            log_action('API_UPDATE_CONFIG_VALIDATION_ERROR', {'reason': 'not_dict'})
            return jsonify({'error': 'Invalid config format'}), 400
        
        data['config'] = config
        save_data(data)
        return jsonify({'status': 'success', 'config': config})
    except Exception as e:
        log_action('API_UPDATE_CONFIG_ERROR', {'error': str(e)})
        return jsonify({'error': str(e)}), 500

@app.route('/api/calculate', methods=['POST'])
def calculate_payments():
    """Endpoint to calculate payments manually (for compatibility)"""
    log_action('API_CALCULATE_PAYMENTS')
    try:
        data = request.json
        result = calculate_payments_internal(data)
        return jsonify(result)
    except Exception as e:
        log_action('API_CALCULATE_PAYMENTS_ERROR', {'error': str(e)})
        return jsonify({'error': str(e)}), 500

@app.route('/api/export', methods=['GET'])
def export_data():
    """Export all data in JSON format"""
    log_action('API_EXPORT_DATA')
    try:
        data = load_data()
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
        log_action('API_EXPORT_DATA_ERROR', {'error': str(e)})
        return jsonify({'error': str(e)}), 500

# Error handlers
@app.errorhandler(404)
def not_found(error):
    log_action('ERROR_404', {'path': request.path})
    return jsonify({'error': 'Not found'}), 404

@app.errorhandler(500)
def internal_error(error):
    log_action('ERROR_500', {'error': str(error)})
    return jsonify({'error': 'Internal server error'}), 500

if __name__ == '__main__':
    print("\n\n\n\n\n\n\n\n\nEVE Online Payments - Made by lolelamo (IGN: Lolewe) \n// v1.0.0 \n// https://github.com/lolelamo/eve-online-payments-site \n//logging enabled\n\n")
    tm.sleep(2.5)
    app.run(debug=True)
