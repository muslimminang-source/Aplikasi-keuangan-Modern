/**
 * ===================================================================
 * ARTA — GOOGLE SHEETS STORAGE & BACKEND ENGINE
 * Desain & Arsitektur: Ruang Keuangan Terarah (Pribadi, Usaha, Keluarga)
 * ===================================================================
 */

var ARTA_MODES_ = ['personal', 'business', 'family'];
var ARTA_LABELS_ = { personal: 'Pribadi', business: 'Usaha', family: 'Keluarga' };
var ARTA_CHUNK_SIZE_ = 43000;
var ARTA_MAX_JSON_ = 4000000;
var ARTA_MAX_EXACT_SHEET_NUMBER_ = 999999999999999;

// --- 1. WEB APP ENTRY POINT ---
function doGet() {
  return HtmlService.createHtmlOutputFromFile('index')
    .setTitle('Arta — Keuangan lebih terarah')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

// --- 2. WORKSPACE API (GET & SAVE) ---
/** Mengambil snapshot ruang keuangan dan nomor revisi terkininya */
function getWorkspace(mode) {
  requireMode_(mode);
  return withArtaLock_(function () {
    var spreadsheet = getArtaSpreadsheet_();
    var current = readSnapshot_(spreadsheet, mode);
    var warning = projectSafely_(spreadsheet, mode, current.state);
    return response_(spreadsheet, current.state, current.revision, warning);
  });
}

/** Menyimpan seluruh ruang keuangan dengan proteksi konkurensi optimistik */
function saveWorkspace(mode, state, expectedRevision) {
  requireMode_(mode);
  var valid = validateState_(state);
  if (valid.isDemo) {
    throw new Error('Data contoh tidak dikirim ke Google Sheets. Mulai dari kosong atau gunakan data nyata terlebih dahulu.');
  }
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
    throw new Error('Revisi data tidak valid. Muat ulang halaman sebelum menyimpan.');
  }
  var json = JSON.stringify(valid);
  if (json.length > ARTA_MAX_JSON_) {
    throw new Error('Data ruang terlalu besar untuk sekali simpan (maksimal 4 juta karakter). Unduh cadangan dan pisahkan pencatatan.');
  }
  return withArtaLock_(function () {
    var spreadsheet = getArtaSpreadsheet_();
    var current = readSnapshot_(spreadsheet, mode);
    if (expectedRevision !== current.revision) {
      throw new Error('CONFLICT: Data ruang ini telah berubah di tab atau perangkat lain. Muat ulang halaman sebelum menyimpan agar catatan terbaru tidak tertimpa.');
    }
    var revision = current.revision + 1;
    if (!Number.isSafeInteger(revision)) {
      throw new Error('Batas revisi tercapai. Cadangkan data sebelum melanjutkan.');
    }
    writeSnapshot_(spreadsheet, mode, json, revision);
    var warning = projectSafely_(spreadsheet, mode, valid);
    return response_(spreadsheet, valid, revision, warning);
  });
}

function response_(spreadsheet, state, revision, warning) {
  var result = { state: state, revision: revision, spreadsheetUrl: spreadsheet.getUrl() };
  if (warning) result.projectionWarning = warning;
  return result;
}

// --- 3. KUNCI KESELAMATAN (LOCK & SPREADSHEET GETTER) ---
function withArtaLock_(callback) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) throw new Error('Penyimpanan sedang digunakan. Tunggu sebentar, lalu coba simpan kembali.');
  try {
    return callback();
  } finally {
    try { SpreadsheetApp.flush(); } finally { lock.releaseLock(); }
  }
}

function requireMode_(mode) {
  if (ARTA_MODES_.indexOf(mode) === -1) throw new Error('Ruang keuangan tidak dikenal: ' + mode);
}

function getArtaSpreadsheet_() {
  var properties = PropertiesService.getScriptProperties();
  var savedId = properties.getProperty('ARTA_SPREADSHEET_ID') || properties.getProperty('SPREADSHEET_ID');
  if (savedId && savedId.trim() !== '') {
    try {
      return SpreadsheetApp.openById(savedId.trim());
    } catch (e) {
      Logger.log('Gagal membuka spreadsheet tersimpan: ' + e);
    }
  }

  // Coba sambungkan ke spreadsheet referensi jika tersedia
  try {
    var defaultId = '10Zo4ATeRQc6K_5pXLc7UNlxKW0ARgF2iDIWtNOVzjunW9Layb3U5Eb_o';
    var sheet = SpreadsheetApp.openById(defaultId);
    properties.setProperty('ARTA_SPREADSHEET_ID', defaultId);
    return sheet;
  } catch (e) {
    // Gunakan spreadsheet aktif atau buat baru jika mandiri
    var active = SpreadsheetApp.getActiveSpreadsheet();
    if (active) {
      properties.setProperty('ARTA_SPREADSHEET_ID', active.getId());
      return active;
    }
    var created = SpreadsheetApp.create('Arta — Catatan Keuangan');
    properties.setProperty('ARTA_SPREADSHEET_ID', created.getId());
    return created;
  }
}

function ownershipValue_(key) {
  return 'arta-v1:' + ScriptApp.getScriptId() + ':' + key;
}

function isOwnedSheet_(sheet, key) {
  return sheet.getDeveloperMetadata().some(function (metadata) {
    return metadata.getKey() === 'ARTA_OWNER' && metadata.getValue() === ownershipValue_(key);
  });
}

function markOwnedSheet_(sheet, key) {
  if (!isOwnedSheet_(sheet, key)) {
    sheet.addDeveloperMetadata('ARTA_OWNER', ownershipValue_(key));
  }
}

// --- 4. ENGINE SNAPSHOT (BACA & TULIS PECAHAN JSON) ---
function readSnapshot_(spreadsheet, mode) {
  var sheet = spreadsheet.getSheetByName('Arta_Data');
  if (!sheet) {
    sheet = spreadsheet.insertSheet('Arta_Data');
    sheet.appendRow(['Mode', 'Revision', 'ChunkIndex', 'ChunkData', 'UpdatedAt']);
    sheet.getRange(1, 1, 1, 5).setFontWeight('bold').setBackground('#174f46').setFontColor('#dafa9a');
    markOwnedSheet_(sheet, 'Arta_Data');
    return { state: initialState_(mode), revision: 0 };
  }

  var data = sheet.getDataRange().getValues();
  var chunks = [];
  var foundRevision = 0;

  for (var i = 1; i < data.length; i++) {
    var row = data[i];
    if (row[0] === mode) {
      foundRevision = Math.max(foundRevision, Number(row[1]) || 0);
      chunks.push({
        index: Number(row[2]) || 0,
        data: String(row[3] || '')
      });
    }
  }

  if (chunks.length === 0) {
    return { state: initialState_(mode), revision: 0 };
  }

  chunks.sort(function (a, b) { return a.index - b.index; });
  var fullJson = chunks.map(function (c) { return c.data; }).join('');

  try {
    var parsed = JSON.parse(fullJson);
    return { state: validateState_(parsed), revision: foundRevision };
  } catch (err) {
    Logger.log('Gagal parse snapshot JSON mode ' + mode + ': ' + err);
    return { state: initialState_(mode), revision: foundRevision };
  }
}

function writeSnapshot_(spreadsheet, mode, json, revision) {
  var sheet = spreadsheet.getSheetByName('Arta_Data');
  if (!sheet) {
    sheet = spreadsheet.insertSheet('Arta_Data');
    sheet.appendRow(['Mode', 'Revision', 'ChunkIndex', 'ChunkData', 'UpdatedAt']);
    sheet.getRange(1, 1, 1, 5).setFontWeight('bold').setBackground('#174f46').setFontColor('#dafa9a');
    markOwnedSheet_(sheet, 'Arta_Data');
  }

  // Hapus data lama untuk mode yang bersangkutan
  var data = sheet.getDataRange().getValues();
  for (var i = data.length - 1; i >= 1; i--) {
    if (data[i][0] === mode) {
      sheet.deleteRow(i + 1);
    }
  }

  // Pecah JSON menjadi chunk aman
  var numChunks = Math.ceil(json.length / ARTA_CHUNK_SIZE_) || 1;
  var timestamp = Utilities.formatDate(new Date(), 'Asia/Jakarta', 'yyyy-MM-dd HH:mm:ss');
  var newRows = [];

  for (var idx = 0; idx < numChunks; idx++) {
    var start = idx * ARTA_CHUNK_SIZE_;
    var chunkStr = json.substring(start, start + ARTA_CHUNK_SIZE_);
    newRows.push([mode, revision, idx, chunkStr, timestamp]);
  }

  if (newRows.length > 0) {
    var startRow = sheet.getLastRow() + 1;
    sheet.getRange(startRow, 1, newRows.length, 5).setValues(newRows);
  }
}

function initialState_(mode) {
  var defaultName = (mode === 'business' ? 'Kas usaha' : mode === 'family' ? 'Kas keluarga' : 'Tunai');
  var today = Utilities.formatDate(new Date(), 'Asia/Jakarta', 'yyyy-MM-dd');
  var month = today.substring(0, 7);
  return {
    version: 1,
    accounts: [
      {
        id: 'cash',
        name: defaultName,
        kind: 'cash',
        openingBalance: 0,
        color: '#F2B35A'
      }
    ],
    transactions: [],
    budgets: [],
    bills: [
      { id: 'bill-1', name: 'Listrik PLN Pascabayar', category: 'Tagihan & Utilitas', estimate: 550000, actual: 0, dueDate: month + '-28', period: month, status: 'Belum', accountId: 'cash', autoRepeat: true },
      { id: 'bill-2', name: 'Wifi & Internet Rumah', category: 'Tagihan & Utilitas', estimate: 385000, actual: 0, dueDate: month + '-25', period: month, status: 'Belum', accountId: 'cash', autoRepeat: true },
      { id: 'bill-3', name: 'Belanja Pokok Rumah Tangga', category: 'Belanja', estimate: 1500000, actual: 0, dueDate: month + '-30', period: month, status: 'Belum', accountId: 'cash', autoRepeat: true },
      { id: 'bill-4', name: 'Cicilan Kendaraan', category: 'Cicilan', estimate: 2100000, actual: 0, dueDate: month + '-29', period: month, status: 'Belum', accountId: 'cash', autoRepeat: true }
    ],
    isDemo: false
  };
}

function validateState_(state) {
  if (!state || typeof state !== 'object') throw new Error('Format data tidak valid.');
  return {
    version: Number(state.version) || 1,
    accounts: Array.isArray(state.accounts) ? state.accounts : [],
    transactions: Array.isArray(state.transactions) ? state.transactions : [],
    budgets: Array.isArray(state.budgets) ? state.budgets : [],
    bills: Array.isArray(state.bills) ? state.bills : [],
    isDemo: Boolean(state.isDemo)
  };
}

// --- 5. PROYEKSI SHEET YANG DAPAT DIBACA MANUSIA ---
function projectSafely_(spreadsheet, mode, state) {
  try {
    var label = ARTA_LABELS_[mode] || mode;

    // 1. Proyeksi Transaksi
    var txSheetName = label + ' — Transaksi';
    var txSheet = getOrCreateProjectionSheet_(spreadsheet, txSheetName);
    var txHeaders = ['ID', 'Tanggal', 'Jenis', 'Kategori', 'Deskripsi', 'Akun', 'Nominal (Rp)'];
    var txRows = [];

    var accountMap = {};
    (state.accounts || []).forEach(function (acc) {
      accountMap[acc.id] = acc.name;
    });

    // Urutkan transaksi terbaru ke terlama
    var sortedTx = (state.transactions || []).slice().sort(function (a, b) {
      return (b.date || '').localeCompare(a.date || '');
    });

    sortedTx.forEach(function (tx) {
      var isIncome = (tx.type === 'income');
      txRows.push([
        tx.id || '',
        tx.date || '',
        isIncome ? 'Pemasukan' : 'Pengeluaran',
        tx.category || 'Umum',
        tx.description || '',
        accountMap[tx.accountId] || tx.accountId || '-',
        Number(tx.amount) || 0
      ]);
    });

    updateSheetContent_(txSheet, txHeaders, txRows, '#174f46', '#dafa9a');

    // 2. Proyeksi Rekening / Akun
    var accSheetName = label + ' — Rekening';
    var accSheet = getOrCreateProjectionSheet_(spreadsheet, accSheetName);
    var accHeaders = ['ID Akun', 'Nama Akun', 'Tipe', 'Saldo Awal (Rp)', 'Total Masuk (Rp)', 'Total Keluar (Rp)', 'Saldo Terkini (Rp)'];
    var accRows = [];

    (state.accounts || []).forEach(function (acc) {
      var inSum = 0;
      var outSum = 0;
      (state.transactions || []).forEach(function (tx) {
        if (tx.accountId === acc.id) {
          if (tx.type === 'income') inSum += (Number(tx.amount) || 0);
          else outSum += (Number(tx.amount) || 0);
        }
      });
      var curBal = (Number(acc.openingBalance) || 0) + inSum - outSum;
      accRows.push([
        acc.id,
        acc.name,
        acc.kind || 'cash',
        Number(acc.openingBalance) || 0,
        inSum,
        outSum,
        curBal
      ]);
    });

    updateSheetContent_(accSheet, accHeaders, accRows, '#174f46', '#dafa9a');

    // 3. Proyeksi Anggaran (Multi-Periode & Rollover & Keterangan Detail)
    var budgetSheetName = label + ' — Anggaran';
    var budgetSheet = getOrCreateProjectionSheet_(spreadsheet, budgetSheetName);
    var budgetHeaders = [
      'Periode',
      'Kategori Anggaran',
      'Keterangan / Detail',
      'Batas Anggaran (Rp)',
      'Realisasi Pengeluaran (Rp)',
      'Sisa Anggaran (Rp)',
      'Pemakaian (%)',
      'Status'
    ];
    var budgetRows = [];

    var todayStr = Utilities.formatDate(new Date(), 'Asia/Jakarta', 'yyyy-MM-dd');
    var currentMonth = todayStr.substring(0, 7);

    // Filter transaksi pengeluaran
    var expenseTxList = (state.transactions || []).filter(function (tx) {
      return tx.type === 'expense' && tx.date;
    });

    // Kumpulkan seluruh periode anggaran
    var periodsMap = {};
    periodsMap[currentMonth] = true;
    if (state.monthlyBudgets && typeof state.monthlyBudgets === 'object') {
      Object.keys(state.monthlyBudgets).forEach(function (p) {
        if (/^\d{4}-\d{2}$/.test(p)) {
          periodsMap[p] = true;
        }
      });
    }

    // Urutkan periode terbaru di bagian atas
    var sortedPeriods = Object.keys(periodsMap).sort().reverse();

    sortedPeriods.forEach(function (period) {
      var bList = [];
      if (state.monthlyBudgets && state.monthlyBudgets[period] && state.monthlyBudgets[period].length > 0) {
        bList = state.monthlyBudgets[period];
      } else if (period === currentMonth && state.budgets && state.budgets.length > 0) {
        bList = state.budgets;
      }

      var periodTxs = expenseTxList.filter(function (tx) {
        return String(tx.date).startsWith(period);
      });

      bList.forEach(function (bg) {
        var cat = (bg.category || '').trim();
        if (!cat) return;
        var note = (bg.note || '').trim();
        var limit = Number(bg.limit) || 0;

        // Hitung realisasi pengeluaran yang cocok dengan kategori & keterangan ini
        var spent = 0;
        periodTxs.forEach(function (tx) {
          if (isBudgetMatch_(tx, cat, note, bList)) {
            spent += (Number(tx.amount) || 0);
          }
        });

        var remaining = limit - spent;
        var pct = limit > 0 ? Math.round((spent / limit) * 100) : 0;

        var status = '✅ Aman (' + pct + '%)';
        if (spent > limit) {
          status = '🚨 Melebihi Anggaran';
        } else if (pct >= 80) {
          status = '⚠️ Mendekati Batas (' + pct + '%)';
        }

        budgetRows.push([
          period,
          cat,
          note || '-',
          limit,
          spent,
          remaining,
          pct + '%',
          status
        ]);
      });
    });

    updateSheetContent_(budgetSheet, budgetHeaders, budgetRows, '#174f46', '#dafa9a');

    return null;
  } catch (err) {
    Logger.log('Peringatan proyeksi sheet: ' + err);
    return 'Gagal memperbarui tampilan proyeksi lembar kerja: ' + err.message;
  }
}

function getOrCreateProjectionSheet_(spreadsheet, name) {
  var sheet = spreadsheet.getSheetByName(name);
  if (!sheet) {
    sheet = spreadsheet.insertSheet(name);
    markOwnedSheet_(sheet, name);
  }
  return sheet;
}

function updateSheetContent_(sheet, headers, rows, headerBg, headerColor) {
  sheet.clearContents();
  sheet.appendRow(headers);
  sheet.getRange(1, 1, 1, headers.length)
    .setFontWeight('bold')
    .setBackground(headerBg)
    .setFontColor(headerColor);

  if (rows.length > 0) {
    sheet.getRange(2, 1, rows.length, headers.length).setValues(rows);
  }
  sheet.autoResizeColumns(1, headers.length);
}

// --- 6. INISIALISASI DATABASE ---
function setupInitialSheets() {
  var ss = getArtaSpreadsheet_();
  var mode = 'personal';
  var current = readSnapshot_(ss, mode);
  projectSafely_(ss, mode, current.state);
  return { success: true, message: 'Database Arta berhasil disiapkan di spreadsheet Anda!' };
}

/** Fungsi pembersih untuk menghapus sheet kebutuhan wajib jika sebelumnya pernah terbuat */
function deleteBillsSheet() {
  var ss = getArtaSpreadsheet_();
  var sheetNames = ['KebutuhanBulanan', 'Pribadi — Kebutuhan Bulanan', 'Usaha — Kebutuhan Bulanan', 'Keluarga — Kebutuhan Bulanan'];
  var deleted = [];
  sheetNames.forEach(function (name) {
    var s = ss.getSheetByName(name);
    if (s) {
      try {
        ss.deleteSheet(s);
        deleted.push(name);
      } catch (e) {
        Logger.log('Gagal menghapus sheet ' + name + ': ' + e);
      }
    }
  });
  return { success: true, message: 'Lembar kebutuhan bulanan berhasil dibersihkan: ' + deleted.join(', ') };
}

// --- 7. MANAJEMEN, SINKRONISASI & SALIN ANGGARAN (DENGAN KETERANGAN DETAIL) ---

/** Helper untuk menghitung string YYYY-MM untuk bulan berikutnya */
function getNextMonth_(monthStr) {
  if (!monthStr || !/^\d{4}-\d{2}$/.test(monthStr)) {
    var today = Utilities.formatDate(new Date(), 'Asia/Jakarta', 'yyyy-MM-dd');
    monthStr = today.substring(0, 7);
  }
  var parts = monthStr.split('-');
  var year = parseInt(parts[0], 10);
  var month = parseInt(parts[1], 10) + 1;
  if (month > 12) {
    month = 1;
    year += 1;
  }
  return year + '-' + (month < 10 ? '0' + month : month);
}

/**
 * Mencocokkan transaksi pengeluaran dengan pos anggaran berdasarkan kategori dan keterangan detail
 */
function isBudgetMatch_(tx, cat, note, allBudgetsInPeriod) {
  var txCat = String(tx.category || 'Lain-lain').trim().toLowerCase();
  var txDesc = String(tx.description || '').trim().toLowerCase();
  var c = cat.toLowerCase();
  var n = (note || '').trim().toLowerCase();

  // 1. Cek apakah transaksi cocok dengan kategori ini
  var catMatches = (txCat === c);
  if (!catMatches && n && n !== '-') {
    if (txCat.indexOf(n) !== -1 || n.indexOf(txCat) !== -1) {
      catMatches = true;
    }
  }
  if (!catMatches) return false;

  // 2. Jika pos anggaran ini memiliki keterangan / detail spesifik:
  if (n && n !== '-') {
    if (txDesc.indexOf(n) !== -1) return true;
    var words = n.split(/\s+/).filter(function (w) { return w.length >= 3; });
    for (var i = 0; i < words.length; i++) {
      if (txDesc.indexOf(words[i]) !== -1) return true;
    }
    return false;
  }

  // 3. Jika pos anggaran ini umum (tanpa keterangan / '-'):
  // Pastikan transaksi ini tidak diambil jika ada pos lain di kategori sama yang memiliki keterangan lebih cocok
  var otherItemsWithNote = (allBudgetsInPeriod || []).filter(function (b) {
    return b.category.toLowerCase() === c && b.note && b.note.trim() !== '-';
  });
  for (var j = 0; j < otherItemsWithNote.length; j++) {
    var oNote = otherItemsWithNote[j].note.trim().toLowerCase();
    if (txDesc.indexOf(oNote) !== -1) return false;
    var oWords = oNote.split(/\s+/).filter(function (w) { return w.length >= 3; });
    for (var k = 0; k < oWords.length; k++) {
      if (txDesc.indexOf(oWords[k]) !== -1) return false;
    }
  }

  return true;
}

/** Mengatur atau memperbarui batas anggaran kategori dan keterangan tertentu */
function setBudget(category, limit, mode, period, note) {
  // Fleksibilitas jika pemanggilan berurutan: (category, note, limit, mode, period)
  if (typeof limit === 'string' && (typeof mode === 'number' || (!isNaN(Number(mode)) && Number(mode) > 0))) {
    var tempNote = limit;
    limit = Number(mode);
    mode = typeof period === 'string' && /^(personal|business|family)$/.test(period) ? period : 'personal';
    period = arguments[4] || null;
    note = tempNote;
  }

  mode = mode || 'personal';
  category = String(category || '').trim();
  note = String(note || '').trim();
  if (note === '-') note = '';
  limit = Number(limit) || 0;
  if (!category || limit <= 0) {
    return { success: false, message: 'Kategori dan nominal batas anggaran harus valid.' };
  }

  var todayStr = Utilities.formatDate(new Date(), 'Asia/Jakarta', 'yyyy-MM-dd');
  var currentMonth = todayStr.substring(0, 7);
  period = (period && /^\d{4}-\d{2}$/.test(period)) ? period : currentMonth;

  var ss = getArtaSpreadsheet_();
  return withArtaLock_(function () {
    var current = readSnapshot_(ss, mode);
    var state = current.state;
    state.budgets = state.budgets || [];
    state.monthlyBudgets = state.monthlyBudgets || {};

    if (!state.monthlyBudgets[period]) {
      state.monthlyBudgets[period] = (period === currentMonth) ? JSON.parse(JSON.stringify(state.budgets)) : [];
    }

    var pList = state.monthlyBudgets[period];
    var foundInPeriod = false;
    for (var i = 0; i < pList.length; i++) {
      var itemNote = String(pList[i].note || '').trim().toLowerCase();
      if (pList[i].category.toLowerCase() === category.toLowerCase() && itemNote === note.toLowerCase()) {
        pList[i].limit = limit;
        pList[i].note = note;
        foundInPeriod = true;
        break;
      }
    }
    if (!foundInPeriod) {
      pList.push({
        id: 'bg-' + new Date().getTime() + '-' + Math.floor(Math.random() * 1000),
        category: category,
        note: note,
        limit: limit
      });
    }

    // Jika period adalah bulan ini, perbarui state.budgets (agregasi kategori unik agar kompatibel dg Web App)
    if (period === currentMonth) {
      var combined = {};
      pList.forEach(function (b) {
        var c = (b.category || '').trim();
        if (!c) return;
        if (!combined[c]) combined[c] = { category: c, limit: 0 };
        combined[c].limit += (Number(b.limit) || 0);
      });
      state.budgets = Object.keys(combined).map(function (k) { return combined[k]; });
    }

    var newRev = (current.revision || 0) + 1;
    writeSnapshot_(ss, mode, JSON.stringify(state), newRev);
    projectSafely_(ss, mode, state);
    var labelNote = note ? (' (' + note + ')') : '';
    return {
      success: true,
      period: period,
      category: category,
      note: note,
      limit: limit,
      message: 'Anggaran ' + category + labelNote + ' [' + period + '] berhasil diatur menjadi Rp ' + limit.toLocaleString('id-ID')
    };
  });
}

/** Mengambil daftar anggaran beserta realisasi untuk periode tertentu */
function getBudgets(mode, period) {
  mode = mode || 'personal';
  var ss = getArtaSpreadsheet_();
  var current = readSnapshot_(ss, mode);
  var state = current.state;
  var todayStr = Utilities.formatDate(new Date(), 'Asia/Jakarta', 'yyyy-MM-dd');
  var currentMonth = todayStr.substring(0, 7);
  period = (period && /^\d{4}-\d{2}$/.test(period)) ? period : currentMonth;

  var bList = [];
  if (state.monthlyBudgets && state.monthlyBudgets[period] && state.monthlyBudgets[period].length > 0) {
    bList = state.monthlyBudgets[period];
  } else if (period === currentMonth && state.budgets && state.budgets.length > 0) {
    bList = state.budgets;
  }

  var periodTxs = (state.transactions || []).filter(function (tx) {
    return tx.type === 'expense' && (tx.date || '').startsWith(period);
  });

  return bList.map(function (bg) {
    var cat = (bg.category || '').trim();
    var note = (bg.note || '').trim();
    var limit = Number(bg.limit) || 0;

    var spent = 0;
    periodTxs.forEach(function (tx) {
      if (isBudgetMatch_(tx, cat, note, bList)) {
        spent += (Number(tx.amount) || 0);
      }
    });

    return {
      period: period,
      category: cat,
      note: note,
      limit: limit,
      spent: spent,
      remaining: limit - spent,
      percent: limit > 0 ? Math.round((spent / limit) * 100) : 0
    };
  });
}

/**
 * Menyalin daftar anggaran dari satu periode ke periode berikutnya
 * @param {string} [sourceMonth] Periode asal (format YYYY-MM), default bulan ini
 * @param {string} [targetMonth] Periode tujuan (format YYYY-MM), default bulan berikutnya
 * @param {string} [mode] Mode ruang keuangan ('personal', 'business', 'family')
 */
function copyBudgetsToNextMonth(sourceMonth, targetMonth, mode) {
  mode = mode || 'personal';
  var todayStr = Utilities.formatDate(new Date(), 'Asia/Jakarta', 'yyyy-MM-dd');
  var currentMonth = todayStr.substring(0, 7);
  sourceMonth = (sourceMonth && /^\d{4}-\d{2}$/.test(sourceMonth)) ? sourceMonth : currentMonth;
  targetMonth = (targetMonth && /^\d{4}-\d{2}$/.test(targetMonth)) ? targetMonth : getNextMonth_(sourceMonth);

  var ss = getArtaSpreadsheet_();
  return withArtaLock_(function () {
    var current = readSnapshot_(ss, mode);
    var state = current.state;
    state.budgets = state.budgets || [];
    state.monthlyBudgets = state.monthlyBudgets || {};

    // Pastikan periode sumber terisi
    if (!state.monthlyBudgets[sourceMonth] || state.monthlyBudgets[sourceMonth].length === 0) {
      if (sourceMonth === currentMonth && state.budgets.length > 0) {
        state.monthlyBudgets[sourceMonth] = JSON.parse(JSON.stringify(state.budgets));
      }
    }

    var sourceList = state.monthlyBudgets[sourceMonth] || state.budgets || [];
    if (sourceList.length === 0) {
      return {
        success: false,
        message: 'Tidak ada anggaran di periode ' + sourceMonth + ' untuk disalin.'
      };
    }

    // Salin ke targetMonth dengan mempertahankan kategori, keterangan, dan batas
    var copiedList = sourceList.map(function (b) {
      return {
        id: 'bg-' + new Date().getTime() + '-' + Math.floor(Math.random() * 1000),
        category: (b.category || '').trim(),
        note: (b.note || '').trim(),
        limit: Number(b.limit) || 0
      };
    });

    state.monthlyBudgets[targetMonth] = copiedList;

    // Jika targetMonth adalah bulan aktif saat ini, sinkronkan juga state.budgets untuk Web App
    if (targetMonth === currentMonth) {
      var combined = {};
      copiedList.forEach(function (b) {
        var c = (b.category || '').trim();
        if (!c) return;
        if (!combined[c]) combined[c] = { category: c, limit: 0 };
        combined[c].limit += (Number(b.limit) || 0);
      });
      state.budgets = Object.keys(combined).map(function (k) { return combined[k]; });
    }

    var newRev = (current.revision || 0) + 1;
    writeSnapshot_(ss, mode, JSON.stringify(state), newRev);
    projectSafely_(ss, mode, state);

    var totalNominal = copiedList.reduce(function (sum, b) { return sum + b.limit; }, 0);
    return {
      success: true,
      sourceMonth: sourceMonth,
      targetMonth: targetMonth,
      count: copiedList.length,
      totalLimit: totalNominal,
      budgets: copiedList,
      message: 'Berhasil menyalin ' + copiedList.length + ' pos anggaran ke periode ' + targetMonth + '!'
    };
  });
}

/** Sinkronisasi data anggaran manual dari sheet kembali ke database snapshot Arta */
function syncBudgetsFromSheet(mode) {
  mode = mode || 'personal';
  var label = ARTA_LABELS_[mode] || mode;
  var ss = getArtaSpreadsheet_();
  var sheet = ss.getSheetByName(label + ' — Anggaran');
  if (!sheet || sheet.getLastRow() <= 1) {
    return { success: false, message: 'Sheet Anggaran kosong atau belum ada.' };
  }

  var todayStr = Utilities.formatDate(new Date(), 'Asia/Jakarta', 'yyyy-MM-dd');
  var currentMonth = todayStr.substring(0, 7);

  // Kolom sheet: Periode (1), Kategori (2), Keterangan / Detail (3), Batas Anggaran (4)
  var numCols = Math.min(sheet.getLastColumn(), 4);
  var data = sheet.getRange(2, 1, sheet.getLastRow() - 1, numCols).getValues();

  var monthlyBudgets = {};

  data.forEach(function (row) {
    var rawPeriod = String(row[0] || '').trim();
    var period = /^\d{4}-\d{2}$/.test(rawPeriod) ? rawPeriod : currentMonth;
    var cat = String(row[1] || '').trim();
    var note = '';
    var limit = 0;

    // Deteksi jika format 4 kolom [Periode, Kategori, Keterangan, Batas]
    if (numCols >= 4 && !isNaN(Number(row[3])) && Number(row[3]) > 0) {
      note = String(row[2] || '').trim();
      if (note === '-') note = '';
      limit = Number(row[3]) || 0;
    } else if (numCols >= 3 && !isNaN(Number(row[2])) && Number(row[2]) > 0) {
      // Format 3 kolom [Periode, Kategori, Batas]
      limit = Number(row[2]) || 0;
    } else if (numCols >= 2 && !isNaN(Number(row[1])) && Number(row[1]) > 0) {
      // Format 2 kolom lama [Kategori, Batas]
      cat = String(row[0] || '').trim();
      limit = Number(row[1]) || 0;
      period = currentMonth;
    }

    if (cat && limit > 0) {
      if (!monthlyBudgets[period]) monthlyBudgets[period] = [];
      var exists = monthlyBudgets[period].some(function (b) {
        return b.category.toLowerCase() === cat.toLowerCase() && (b.note || '').toLowerCase() === note.toLowerCase();
      });
      if (!exists) {
        monthlyBudgets[period].push({
          id: 'bg-' + cat.toLowerCase().replace(/[^a-z0-9]/g, '-') + (note ? '-' + note.toLowerCase().replace(/[^a-z0-9]/g, '-') : ''),
          category: cat,
          note: note,
          limit: limit
        });
      }
    }
  });

  return withArtaLock_(function () {
    var current = readSnapshot_(ss, mode);
    var state = current.state;
    state.monthlyBudgets = monthlyBudgets;

    // Update state.budgets dengan kategori unik untuk bulan aktif
    if (monthlyBudgets[currentMonth]) {
      var combined = {};
      monthlyBudgets[currentMonth].forEach(function (b) {
        var c = (b.category || '').trim();
        if (!c) return;
        if (!combined[c]) combined[c] = { category: c, limit: 0 };
        combined[c].limit += (Number(b.limit) || 0);
      });
      state.budgets = Object.keys(combined).map(function (k) { return combined[k]; });
    }

    var newRev = (current.revision || 0) + 1;
    writeSnapshot_(ss, mode, JSON.stringify(state), newRev);
    projectSafely_(ss, mode, state);
    return {
      success: true,
      message: 'Berhasil menyinkronkan data anggaran & keterangan dari sheet!',
      monthlyCount: Object.keys(monthlyBudgets).length
    };
  });
}

/** Menu khusus saat Google Spreadsheet dibuka */
function onOpen() {
  try {
    var ui = SpreadsheetApp.getUi();
    ui.createMenu('🍃 Arta Keuangan')
      .addItem('📋 Salin Anggaran ke Bulan Depan', 'menuCopyBudgetsToNextMonth')
      .addItem('🔄 Sinkronkan Anggaran dari Sheet', 'menuSyncBudgetsFromSheet')
      .addItem('📊 Perbarui Seluruh Tampilan Sheet', 'menuRefreshAllProjections')
      .addToUi();
  } catch (e) {
    Logger.log('Menu UI tidak tersedia: ' + e);
  }
}

function menuCopyBudgetsToNextMonth() {
  var res = copyBudgetsToNextMonth();
  var ui = SpreadsheetApp.getUi();
  if (res && res.success) {
    ui.alert('Sukses', res.message + '\nTotal: ' + res.count + ' kategori (Rp ' + res.totalLimit.toLocaleString('id-ID') + ')', ui.ButtonSet.OK);
  } else {
    ui.alert('Perhatian', (res && res.message) ? res.message : 'Gagal menyalin anggaran.', ui.ButtonSet.OK);
  }
}

function menuSyncBudgetsFromSheet() {
  var res = syncBudgetsFromSheet('personal');
  var ui = SpreadsheetApp.getUi();
  ui.alert(res.success ? 'Sukses' : 'Gagal', res.message, ui.ButtonSet.OK);
}

function menuRefreshAllProjections() {
  var ss = getArtaSpreadsheet_();
  ['personal', 'business', 'family'].forEach(function (m) {
    var current = readSnapshot_(ss, m);
    if (current && current.state) {
      projectSafely_(ss, m, current.state);
    }
  });
  SpreadsheetApp.getUi().alert('Tampilan seluruh sheet berhasil diperbarui!');
}
