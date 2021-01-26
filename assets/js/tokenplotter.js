var DATA_DIR = '/assets/files/tokenplotter_data/'
var DATETIMES = getDatetimes(DATA_DIR + 'blocktimes.json');
var TOKEN_INFO = loadJson(DATA_DIR + 'tokens.json');
var BASE_SYMBOL = '';
var QUOTE_SYMBOLS = [];
var TRACES = [];

function getDatetimes (url) {
	var blocktimes = loadJson(url);
	var n_rows = blocktimes['block_diffs'].length;
	var start_ts = blocktimes['start_ts'];
	var delta = blocktimes['delta'];
	var datetimes = [];

	for (var i=0; i<n_rows; i++) {
		datetimes.push(new Date(1000 * (
			start_ts + i * delta + blocktimes['ts_offsets'][i]
		)));
	}

	return datetimes;
}

function loadJson (url) {
	var data;

	$.ajax({
		    'async': false, 'global': false, 'url': url, 'dataType': "json",
		    'success': function (tmp) { data = tmp; }
	});

	return data;
}


function getTokenData (symbol) {
	if ('data' in TOKEN_INFO) {
		return TOKEN_INFO[symbol].data;
	} else {
		var filename = DATA_DIR + TOKEN_INFO[symbol].address.toLowerCase() + '.json';
		TOKEN_INFO[symbol].data = loadJson(filename);
		return TOKEN_INFO[symbol].data;
	}
}

function quoteChange () {
	var quote_dropdown = document.getElementById('select-quote');

	QUOTE_SYMBOLS = quote_dropdown.value;

	var traces = [], namestr = '';

	for (opt of quote_dropdown.options) {
		if (opt.selected) {
			if (!(opt.text in TRACES)) {
				TRACES[opt.text] = calculateTrace(opt.text, BASE_SYMBOL);
			}
			traces.push(TRACES[opt.text]);
			namestr += ', ' + opt.text;
		}
	}
	var layout = {
		title: 'Price history for ' + namestr.slice(2) + ' (in ' + BASE_SYMBOL + ')',
		yaxis: {
			title: 'Price (' + BASE_SYMBOL + ')'
		}
	};

	Plotly.newPlot('graph', traces, layout);
}

function baseChange() {
	var base_dropdown = document.getElementById('select-base');
	if (base_dropdown.value != BASE_SYMBOL){
		BASE_SYMBOL = base_dropdown.value;
		TRACES = {};
		quoteChange();
	}
}

function calculateTrace (quote_symbol, base_symbol) {
	if (quote_symbol == 'ETH' && base_symbol == 'ETH') {
		return {x: [], y: []}
	}

	var quote_offset = 0, base_offset = 0;
	if (quote_symbol != 'ETH') {
		quote_data = getTokenData(quote_symbol);
		quote_offset = quote_data.start_index;
	}
	if (base_symbol != 'ETH') {
		base_data = getTokenData(base_symbol);
		base_offset = base_data.start_index;
	}
	var start_from = Math.max(quote_offset, base_offset);
	
	var x = []; y = [];

	for (var i=start_from; i<DATETIMES.length; i++) {
		var quote_val = 1, base_val = 1;
		if (quote_symbol != 'ETH') {
			quote_val = quote_data.prices[i - quote_offset];
		}
		if (base_symbol != 'ETH') {
			base_val = base_data.prices[i - base_offset];
		}
		x.push(DATETIMES[i]);
		y.push(quote_val / base_val);
	}

	return {x: x, y: y, name: quote_symbol}
}


function addDropdownOptions (token_info) {
	var quote_dropdown = document.getElementById('select-quote');
	for (symbol of Object.keys(token_info).concat(['ETH'])) {
		var opt = document.createElement("option");
		opt.text = symbol;
		quote_dropdown.add(opt);
	}
	
	var base_dropdown = document.getElementById('select-base');
	for (symbol of ['ETH'].concat(Object.keys(token_info))) {
		var opt = document.createElement("option");
		opt.text = symbol;
		base_dropdown.add(opt);	
	}
	base_dropdown.value = 'DAI';
	quote_dropdown.value = 'ETH';
	quote_dropdown.addEventListener("change", quoteChange);
	base_dropdown.addEventListener("change", baseChange);

	baseChange();
}

addDropdownOptions(TOKEN_INFO);
//quoteChange(document.getElementById('select-quote'));
