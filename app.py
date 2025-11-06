from flask import Flask, render_template, request, jsonify
import json
import os

app = Flask(__name__)

# Configuration and data file
DATA_FILE = 'data.json'

def load_data():
    """Load data from the JSON file or create a default structure"""
    if os.path.exists(DATA_FILE):
        with open(DATA_FILE, 'r') as f:
            return json.load(f)
    return {
        'config': {
            'levelValues': {str(i): i * 100000 for i in range(1, 11)},
            'hasSalvager': False,
            'salvagerPercent': 10,
            'currency': 'ISK',
            'autoCalculate': True
        },
        'members': [],
        'sites': []
    }

def save_data(data):
    """Save data to the JSON file"""
    with open(DATA_FILE, 'w') as f:
        json.dump(data, f, indent=2, ensure_ascii=False)

def calculate_payments_internal(data):
    """Compute payments based on the provided data"""
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
    
    # Process each site
    for site in sites:
        # Ignore sites not performed (level 99)
        if site['level'] == 99:
            continue
        
        site_value = int(level_values.get(str(site['level']), 0))
        participants = site['participants']
        participant_count = len(participants)
        
        if participant_count == 0:
            continue
        
        salvager_bonus = 0
        regular_share = site_value
        
        # Calculate salvager bonus if enabled
        salvager_bonus_per_salvager = 0
        salvagers_in_site = []
        if has_salvager:
            salvagers_in_site = [m for m in members if m.get('isSalvager') and m['id'] in participants]
            if salvagers_in_site:
                salvager_pool = site_value * salvager_percent
                salvager_bonus_per_salvager = salvager_pool / len(salvagers_in_site)
                regular_share = site_value - salvager_pool
        
        # Split the regular share among all participants
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
    
    # Prepare result
    result = {
        'payments': list(payments.values()),
        'totalPaid': sum(p['total'] for p in payments.values()),
        'totalSites': len([s for s in sites if s['level'] != 99]),
        'config': config
    }
    
    return result

@app.route('/')
def index():
    """Home page"""
    return render_template('index.html')

@app.route('/api/data', methods=['GET'])
def get_data():
    """Get all data including payment calculation"""
    data = load_data()
    
    # If autoCalculate is enabled, include calculations
    if data.get('config', {}).get('autoCalculate', True):
        calculations = calculate_payments_internal(data)
        data['calculations'] = calculations
    
    return jsonify(data)

@app.route('/api/data', methods=['POST'])
def update_data():
    """Update data and return updated calculations"""
    data = request.json
    save_data(data)
    
    # Automatically calculate payments
    if data.get('config', {}).get('autoCalculate', True):
        calculations = calculate_payments_internal(data)
        return jsonify({
            'status': 'success',
            'calculations': calculations
        })
    
    return jsonify({'status': 'success'})

@app.route('/api/config', methods=['GET'])
def get_config():
    """Get only the configuration"""
    data = load_data()
    return jsonify(data.get('config', {}))

@app.route('/api/config', methods=['POST'])
def update_config():
    """Update only the configuration"""
    data = load_data()
    config = request.json
    data['config'] = config
    save_data(data)
    return jsonify({'status': 'success', 'config': config})

@app.route('/api/calculate', methods=['POST'])
def calculate_payments():
    """Endpoint to calculate payments manually (for compatibility)"""
    data = request.json
    result = calculate_payments_internal(data)
    return jsonify(result)

@app.route('/api/export', methods=['GET'])
def export_data():
    """Export all data in JSON format"""
    data = load_data()
    calculations = calculate_payments_internal(data)
    
    export = {
        'config': data.get('config', {}),
        'members': data.get('members', []),
        'sites': data.get('sites', []),
        'calculations': calculations
    }
    
    return jsonify(export)

if __name__ == '__main__':
    app.run(debug=True)
