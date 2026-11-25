function doGet() {
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('Fingerprint Attendance Portal')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

const DB_STORAGE_KEY = "RAW_ATTENDANCE_LOGS";
const DB_USERS_KEY = "EMPLOYEE_DIRECTORY";

function detectDelimiter(lines) {
  const sample = lines.slice(0, 5).join("\n");
  if (sample.indexOf("\t") > -1) return /\t+/;
  if (sample.indexOf(",") > -1) return /,/;
  if (sample.indexOf(";") > -1) return /;/;
  return / {2,}|\s+/;
}

function isValidDateTime(val) {
  if (!val || typeof val !== "string") return false;
  const datePattern = /\d{4}[-/.]\d{1,2}[-/.]\d{1,2}|\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}/;
  const timePattern = /\d{1,2}:\d{2}(:\d{2})?/;
  if (datePattern.test(val) && timePattern.test(val)) {
    const d = new Date(val.replace(/-/g, "/"));
    return !isNaN(d.getTime());
  }
  return false;
}

// Ingest raw punch logs
function uploadLogsDirectly(rawText) {
  try {
    const lines = rawText.trim().split(/\r?\n/).filter(l => l.trim().length > 0);
    if (!lines.length) return { success: false, message: "Uploaded file is empty." };

    const delimiter = detectDelimiter(lines);
    const firstRowCols = lines[0].split(delimiter).map(c => c.trim().replace(/^["']|["']$/g, ''));
    
    let idIdx = -1;
    let timeIdx = -1;
    let startIdx = 0;

    const headerKeywordsId = ["id", "userid", "user_id", "pin", "badgenumber", "emp", "employee", "card", "enno"];
    const headerKeywordsTime = ["time", "punch", "datetime", "date_time", "checktime", "timestamp"];

    firstRowCols.forEach((col, idx) => {
      const clean = col.toLowerCase().replace(/[^a-z0-9]/g, "");
      if (headerKeywordsId.some(k => clean.includes(k)) && idIdx === -1) idIdx = idx;
      if (headerKeywordsTime.some(k => clean.includes(k)) && timeIdx === -1) timeIdx = idx;
    });

    if (idIdx !== -1 && timeIdx !== -1) {
      startIdx = 1;
    } else {
      const testRowIdx = lines.length > 1 ? 1 : 0;
      const testCols = lines[testRowIdx].split(delimiter).map(c => c.trim().replace(/^["']|["']$/g, ''));

      testCols.forEach((col, idx) => {
        if (isValidDateTime(col) && timeIdx === -1) {
          timeIdx = idx;
        } else if (/^\d{1,10}$/.test(col) && idIdx === -1) {
          idIdx = idx;
        }
      });
      if (idIdx === -1) {
        idIdx = testCols.findIndex((_, idx) => idx !== timeIdx);
      }
      startIdx = isValidDateTime(firstRowCols[timeIdx]) ? 0 : 1;
    }

    if (idIdx === -1 || timeIdx === -1) {
      return { success: false, message: "Could not automatically identify User ID and Timestamp columns." };
    }

    const newPunches = [];
    for (let i = startIdx; i < lines.length; i++) {
      const cols = lines[i].split(delimiter).map(c => c.trim().replace(/^["']|["']$/g, ''));
      if (cols[idIdx] && cols[timeIdx]) {
        const cleanDateStr = cols[timeIdx].replace(/-/g, "/");
        const dt = new Date(cleanDateStr);
        if (!isNaN(dt.getTime())) {
          newPunches.push({
            userId: String(cols[idIdx]),
            timestamp: dt.toISOString()
          });
        }
      }
    }

    if (!newPunches.length) {
      return { success: false, message: "No valid punch rows could be parsed." };
    }

    const props = PropertiesService.getScriptProperties();
    let existing = [];
    const stored = props.getProperty(DB_STORAGE_KEY);
    if (stored) {
      try { existing = JSON.parse(stored); } catch(e) { existing = []; }
    }

    const combined = existing.concat(newPunches);
    props.setProperty(DB_STORAGE_KEY, JSON.stringify(combined));

    return {
      success: true,
      message: `Detected ID & Time. Successfully imported ${newPunches.length} punch records!`
    };
  } catch (err) {
    return { success: false, message: "Server error: " + err.message };
  }
}

// Ingest Name-ID mapping file
function uploadEmployeeMapping(rawText) {
  try {
    const lines = rawText.trim().split(/\r?\n/).filter(l => l.trim().length > 0);
    if (!lines.length) return { success: false, message: "Mapping file is empty." };

    const delimiter = detectDelimiter(lines);
    const firstRowCols = lines[0].split(delimiter).map(c => c.trim().replace(/^["']|["']$/g, ''));
    
    let idIdx = -1;
    let nameIdx = -1;
    let startIdx = 0;

    const headerKeywordsId = ["id", "userid", "user_id", "pin", "badgenumber", "code", "emp_id"];
    const headerKeywordsName = ["name", "username", "employeename", "fullname", "emp_name"];

    firstRowCols.forEach((col, idx) => {
      const clean = col.toLowerCase().replace(/[^a-z0-9]/g, "");
      if (headerKeywordsId.some(k => clean.includes(k)) && idIdx === -1) idIdx = idx;
      if (headerKeywordsName.some(k => clean.includes(k)) && nameIdx === -1) nameIdx = idx;
    });

    if (idIdx !== -1 && nameIdx !== -1) {
      startIdx = 1;
    } else {
      // Auto-detect by checking which column looks like an ID (digits) vs Name (text)
      const testRow = lines.length > 1 ? lines[1] : lines[0];
      const cols = testRow.split(delimiter).map(c => c.trim().replace(/^["']|["']$/g, ''));
      if (cols.length >= 2) {
        if (/^\d+$/.test(cols[0])) {
          idIdx = 0;
          nameIdx = 1;
        } else {
          nameIdx = 0;
          idIdx = 1;
        }
      }
      startIdx = (idIdx !== -1 && /^\d+$/.test(firstRowCols[idIdx])) ? 0 : 1;
    }

    if (idIdx === -1 || nameIdx === -1) {
      return { success: false, message: "Could not identify ID and Name columns automatically." };
    }

    const props = PropertiesService.getScriptProperties();
    let directory = {};
    const storedDir = props.getProperty(DB_USERS_KEY);
    if (storedDir) {
      try { directory = JSON.parse(storedDir); } catch(e) { directory = {}; }
    }

    let count = 0;
    for (let i = startIdx; i < lines.length; i++) {
      const cols = lines[i].split(delimiter).map(c => c.trim().replace(/^["']|["']$/g, ''));
      if (cols[idIdx] && cols[nameIdx]) {
        directory[String(cols[idIdx])] = String(cols[nameIdx]);
        count++;
      }
    }

    props.setProperty(DB_USERS_KEY, JSON.stringify(directory));
    return {
      success: true,
      message: `Successfully linked ${count} employee names to IDs!`
    };
  } catch (err) {
    return { success: false, message: "Server error: " + err.message };
  }
}

// Fetch processed records paired with employee names
function getProcessedRecords() {
  const props = PropertiesService.getScriptProperties();
  const stored = props.getProperty(DB_STORAGE_KEY);
  if (!stored) return [];

  let directory = {};
  const storedDir = props.getProperty(DB_USERS_KEY);
  if (storedDir) {
    try { directory = JSON.parse(storedDir); } catch(e) { directory = {}; }
  }

  const rawList = JSON.parse(stored);
  const grouped = {};

  rawList.forEach(p => {
    const dt = new Date(p.timestamp);
    const dateKey = Utilities.formatDate(dt, Session.getScriptTimeZone(), "yyyy-MM-dd");
    const groupKey = `${p.userId}_${dateKey}`;

    if (!grouped[groupKey]) {
      grouped[groupKey] = { userId: p.userId, date: dateKey, timestamps: [] };
    }
    grouped[groupKey].timestamps.push(dt);
  });

  const processed = [];

  Object.keys(grouped).forEach(k => {
    const item = grouped[k];
    item.timestamps.sort((a, b) => a - b);

    const firstPunch = item.timestamps[0];
    const lastPunch = item.timestamps[item.timestamps.length - 1];

    const arrivalStr = Utilities.formatDate(firstPunch, Session.getScriptTimeZone(), "HH:mm:ss");
    const dismissalStr = Utilities.formatDate(lastPunch, Session.getScriptTimeZone(), "HH:mm:ss");

    const arrParts = arrivalStr.split(":").map(Number);
    const arrMinutes = arrParts[0] * 60 + arrParts[1];

    const disParts = dismissalStr.split(":").map(Number);
    const disMinutes = disParts[0] * 60 + disParts[1];

    let lateStatus = "On Time";
    let isLate = false;
    let lateMinutes = 0;
    if (arrMinutes > 515) {
      lateMinutes = arrMinutes - 510;
      lateStatus = `Late (+${lateMinutes}m)`;
      isLate = true;
    }

    let dismissalStatus = "Normal Dismissal";
    let isEarly = false;
    let isMissingPunch = false;
    let earlyMinutes = 0;

    if (item.timestamps.length === 1) {
      dismissalStatus = "Missing Checkout";
      isMissingPunch = true;
    } else if (disMinutes < 990) {
      earlyMinutes = 990 - disMinutes;
      dismissalStatus = `Early (-${earlyMinutes}m)`;
      isEarly = true;
    }

    const hoursWorked = parseFloat(((lastPunch - firstPunch) / (1000 * 3600)).toFixed(2));
    const empName = directory[item.userId] || "Unassigned";

    processed.push({
      userId: item.userId,
      userName: empName,
      date: item.date,
      arrival: arrivalStr,
      arrivalStatus: lateStatus,
      isLate: isLate,
      lateMinutes: lateMinutes,
      dismissal: dismissalStr,
      dismissalStatus: dismissalStatus,
      isEarly: isEarly,
      isMissingPunch: isMissingPunch,
      earlyMinutes: earlyMinutes,
      totalHours: hoursWorked
    });
  });

  return processed.sort((a, b) => (a.date < b.date ? 1 : -1));
}

function clearAllLogs() {
  PropertiesService.getScriptProperties().deleteProperty(DB_STORAGE_KEY);
  return "Attendance records cleared.";
}

function clearAllDirectory() {
  PropertiesService.getScriptProperties().deleteProperty(DB_USERS_KEY);
  return "Employee name mappings cleared.";
}
