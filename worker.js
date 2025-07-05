try {
    // This loads the PapaParse library from the CDN.
    importScripts('https://cdn.jsdelivr.net/npm/papaparse@5.4.1/papaparse.min.js');
} catch (e) {
    self.postMessage({ type: 'error', payload: 'Fatal: Could not load PapaParse from CDN. Check internet connection.' });
    throw e;
}

self.onmessage = async (event) => {
    const { csvFile, xmlFile, csvSpeedUnits, xmlSpeedUnits, manualOffset, resampleInterval } = event.data;
    try {
        postStatus('Worker: Received data. Processing...');
        let csvData = await parseCsv(csvFile);
        postStatus('Worker: CSV parsed.');
        
        let xmlData = await parseXml(xmlFile);
        postStatus('Worker: XML parsed.');

        const MPH_TO_KPH = 1.60934;
        if (csvSpeedUnits === 'mph') csvData[csvData._speedKey] = csvData[csvData._speedKey].map(v => v * MPH_TO_KPH);
        if (xmlSpeedUnits === 'mph') xmlData[xmlData._speedKey] = xmlData[xmlData._speedKey].map(v => v * MPH_TO_KPH);

        postStatus('Worker: Resampling data...');
        const resampledCsv = resampleData(csvData, resampleInterval);
        const resampledXml = resampleData(xmlData, resampleInterval);
        
        if (resampledCsv.time.length < 10 || resampledXml.time.length < 10) {
            throw new Error("Not enough data points after resampling for a reliable analysis.");
        }

        let timeOffset;
        if (manualOffset !== null) {
            timeOffset = manualOffset;
        } else {
            postStatus('Worker: Calculating optimal time offset...');
            timeOffset = findOptimalOffset(resampledCsv, resampledXml);
        }
        
        postStatus('Worker: Merging data...');
        const mergedData = mergeData(resampledCsv, resampledXml, timeOffset);
        const unparseResult = Papa.unparse(mergedData);

        self.postMessage({
            type: 'result',
            payload: { resampledCsv, resampledXml, timeOffset, unparseResult }
        });
    } catch (error) {
        self.postMessage({ type: 'error', payload: error.message });
    }
};

function postStatus(message) { self.postMessage({ type: 'status', payload: message }); }

function parseCsv(file) {
    return new Promise((resolve, reject) => {
        Papa.parse(file, {
            worker: false, header: true, dynamicTyping: true, skipEmptyLines: true, comments: "#",
            complete: res => {
                if (res.errors.length) return reject(new Error(res.errors[0].message));
                const timeKey = res.meta.fields.find(f => f.toLowerCase().includes('time'));
                const speedKey = res.meta.fields.find(f => f.toLowerCase().includes('speed'));
                if (!timeKey || !speedKey) return reject(new Error('Could not auto-find Time/Speed columns in CSV.'));
                const data = { _timeKey: timeKey, _speedKey: speedKey };
                res.meta.fields.forEach(f => { data[f] = res.data.map(row => row[f]); });
                resolve(data);
            },
            error: err => reject(new Error(err.message))
        });
    });
}

function parseXml(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = e => {
            const text = e.target.result;
            const logRegex = /<EngineDataLog>[\s\S]*?<\/EngineDataLog>/g;
            const entries = text.match(logRegex);
            if (!entries) return reject(new Error("No <EngineDataLog> entries found."));
            
            const data = {};
            const firstLogEntry = entries[0];
            const keyRegex = /<([A-Za-z]+)>/g;
            let keyMatch;
            while((keyMatch = keyRegex.exec(firstLogEntry))) if(keyMatch[1] !== 'EngineDataLog') data[keyMatch[1]] = [];
            const keys = Object.keys(data);
            if (keys.length === 0) return reject(new Error("Could not find tags in <EngineDataLog>."));

            for(const entryText of entries) {
                keys.forEach(key => {
                    const valRegex = new RegExp('<' + key + '>([\\s\\S]*?)<\\/' + key + '>');
                    const valMatch = valRegex.exec(entryText);
                    const rawVal = valMatch ? valMatch[1].trim() : null;
                    let finalVal = NaN;
                    
                    if (key === 'LogTime') {
                        if (!rawVal || !/^\d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(rawVal)) {
                            finalVal = null;
                        } else {
                            const parts = rawVal.split(':');
                            const secParts = parts[2].split('.');
                            const hours = parseInt(parts[0], 10);
                            const minutes = parseInt(parts[1], 10);
                            const seconds = parseInt(secParts[0], 10);
                            const fractional = parseFloat('0.' + (secParts[1] || '0'));
                            finalVal = (hours * 3600) + (minutes * 60) + seconds + fractional;
                        }
                    } else {
                        finalVal = parseFloat(rawVal);
                    }
                    data[key].push(isNaN(finalVal) ? null : finalVal);
                });
            }

            if (!data['LogTime'] || data['LogTime'].length === 0 || !data['VehicleSpeed'] || data['VehicleSpeed'].length === 0) {
                return reject(new Error("XML file must contain <LogTime> and <VehicleSpeed> tags with data."));
            }
            data._timeKey = 'LogTime';
            data._speedKey = 'VehicleSpeed';
            resolve(data);
        };
        reader.onerror = () => reject(new Error('Failed to read XML file.'));
        reader.readAsText(file);
    });
}
    
function resampleData(data, interval) {
    const timeKey = data._timeKey;
    const validTimes = data[timeKey].filter(t => t !== null && isFinite(t));
    if (validTimes.length === 0) throw new Error("No valid time data in column '" + timeKey + "'.");
    
    let tMin = Infinity;
    let tMax = -Infinity;
    for (let i = 0; i < validTimes.length; i++) {
        if (validTimes[i] < tMin) tMin = validTimes[i];
        if (validTimes[i] > tMax) tMax = validTimes[i];
    }

    const uniformTime = [];
    for (let t = tMin; t <= tMax; t += interval) uniformTime.push(t);
    const resampled = { time: uniformTime, _speedKey: data._speedKey };
    const otherKeys = Object.keys(data).filter(k => !k.startsWith('_'));
    const timeValueMap = new Map();
    for(let i=0; i < data[timeKey].length; i++) if(data[timeKey][i] !== null) timeValueMap.set(data[timeKey][i], i);
    const sortedOriginalTimes = Array.from(timeValueMap.keys()).sort((a,b) => a-b);

    otherKeys.forEach(key => {
        resampled[key] = uniformTime.map(t => {
            const i = sortedOriginalTimes.findIndex(x => x >= t);
            if (i <= 0) return data[key][timeValueMap.get(sortedOriginalTimes[0])];
            if (i >= sortedOriginalTimes.length) return data[key][timeValueMap.get(sortedOriginalTimes[sortedOriginalTimes.length - 1])];
            const t1 = sortedOriginalTimes[i - 1], t2 = sortedOriginalTimes[i];
            const i1 = timeValueMap.get(t1), i2 = timeValueMap.get(t2);
            const y1 = data[key][i1], y2 = data[key][i2];
            if (y1 === null || y2 === null || isNaN(y1) || isNaN(y2)) return y1;
            if (t2 === t1) return y1;
            const alpha = (t - t1) / (t2 - t1);
            return y1 + alpha * (y2 - y1);
        });
    });
    return resampled;
}

function findOptimalOffset(resampledCsv, resampledXml) {
    const csvSpeed = resampledCsv[resampledCsv._speedKey];
    const xmlSpeed = resampledXml[resampledXml._speedKey];
    const csvMean = csvSpeed.reduce((a, b) => a + (b || 0), 0) / csvSpeed.length;
    const xmlMean = xmlSpeed.reduce((a, b) => a + (b || 0), 0) / xmlSpeed.length;
    const csvNorm = csvSpeed.map(v => (v || 0) - csvMean);
    const xmlNorm = xmlSpeed.map(v => (v || 0) - xmlMean);
    let bestOffset = 0, maxCorr = -Infinity;
    const maxLag = Math.floor(xmlNorm.length / 2);
    for (let lag = -maxLag; lag <= maxLag; lag++) {
        let dotProduct = 0;
        for (let i = 0; i < csvNorm.length; i++) {
            const j = i - lag;
            if (j >= 0 && j < xmlNorm.length) dotProduct += csvNorm[i] * xmlNorm[j];
        }
        if (dotProduct > maxCorr) {
            maxCorr = dotProduct;
            const interval = resampledCsv.time[1] - resampledCsv.time[0];
            bestOffset = lag * interval;
        }
    }
    return bestOffset;
}

// ✅ CORRECTED: This merge logic is robust and finds the closest corresponding data points.
function mergeData(resampledCsv, resampledXml, offset) {
    const merged = [];
    const csvTime = resampledCsv.time;
    const xmlTime = resampledXml.time;
    const interval = csvTime[1] - csvTime[0];
    const xmlStartTime = xmlTime[0];

    const csvKeys = Object.keys(resampledCsv).filter(k => !k.startsWith('_') && k !== 'time');
    const xmlKeys = Object.keys(resampledXml).filter(k => !k.startsWith('_') && k !== 'time');

    for (let i = 0; i < csvTime.length; i++) {
        const t_csv = csvTime[i];
        const row = { Time: t_csv.toFixed(3) };

        // Add all CSV data for this timestamp
        csvKeys.forEach(key => {
            row['csv_' + key] = resampledCsv[key][i];
        });

        // Find the corresponding index in the XML data by calculating its expected position
        const t_target = t_csv - offset;
        const j = Math.round((t_target - xmlStartTime) / interval);

        // Check if the calculated index is valid and add the XML data
        if (j >= 0 && j < xmlTime.length) {
             xmlKeys.forEach(key => {
                row['xml_' + key] = resampledXml[key][j];
            });
        } else {
            // If there's no corresponding XML data for this timestamp, fill with nulls
             xmlKeys.forEach(key => {
                row['xml_' + key] = null;
            });
        }
        merged.push(row);
    }
    return merged;
}