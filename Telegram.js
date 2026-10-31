/**
 * ===================================================================
 * ARTA — INTEGRASI TELEGRAM BOT & NOTIFIKASI
 * Terhubung langsung ke Google Sheets & Snapshot Arta
 * ===================================================================
 */

// Deployment URL Web App Terbaru (Sudah Publik - Anyone)
var LATEST_DEPLOYMENT_URL = 'https://script.google.com/macros/s/AKfycbyCRt6htYFeGqDepJa34CspdzdF8Oo7UxcS-53TtLBqC6jPJGcDnV52-D32rSEkMiL4Zg/exec';

function getBotToken() {
  return PropertiesService.getScriptProperties().getProperty('TELEGRAM_BOT_TOKEN');
}

function getAllowedChatId() {
  return PropertiesService.getScriptProperties().getProperty('ALLOWED_TELEGRAM_USER_ID');
}

// --- SETUP WEBHOOK TELEGRAM ---
function setTelegramWebhook(manualUrl) {
  var token = getBotToken();
  if (!token) throw new Error('Isi TELEGRAM_BOT_TOKEN di Project Settings > Script Properties terlebih dahulu.');

  // Prioritas URL: manualUrl -> getService().getUrl() -> LATEST_DEPLOYMENT_URL
  var webAppUrl = manualUrl;
  if (!webAppUrl) {
    try {
      webAppUrl = ScriptApp.getService().getUrl();
    } catch (e) {
      Logger.log('Tidak dapat mengambil URL otomatis: ' + e);
    }
  }

  // Wajib gunakan /exec, jangan pernah gunakan /dev untuk webhook Telegram
  if (webAppUrl && webAppUrl.indexOf('/dev') !== -1) {
    webAppUrl = webAppUrl.replace('/dev', '/exec');
  }

  if (!webAppUrl || webAppUrl.indexOf('/exec') === -1) {
    webAppUrl = LATEST_DEPLOYMENT_URL;
  }

  var url = 'https://api.telegram.org/bot' + token + '/setWebhook?url=' + encodeURIComponent(webAppUrl);
  var resp = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  var result = JSON.parse(resp.getContentText());
  Logger.log('Set Webhook Result: ' + JSON.stringify(result));

  // Kirim notifikasi konfirmasi langsung ke Telegram user
  var allowedId = getAllowedChatId();
  if (allowedId && result.ok) {
    sendTelegramMessage(allowedId, '🚀 <b>Bot Arta Berhasil Terhubung!</b>\n\n' +
      'Webhook aktif ke:\n<code>' + webAppUrl + '</code>\n\n' +
      'Sekarang Anda sudah bisa mencatat langsung lewat chat:\n' +
      '• <code>/saldo</code>\n' +
      '• <code>/masuk 500k Gaji</code>\n' +
      '• <code>/keluar 25k Makan Siang</code>\n' +
      '• <code>/tagihan</code>');
  }

  return result;
}

// Cek status webhook saat ini di Telegram
function getWebhookInfo() {
  var token = getBotToken();
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN belum diatur.');
  var url = 'https://api.telegram.org/bot' + token + '/getWebhookInfo';
  var resp = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  var result = JSON.parse(resp.getContentText());
  Logger.log('Webhook Info:\n' + JSON.stringify(result, null, 2));
  return result;
}

// Hapus webhook Telegram jika ingin reset
function deleteTelegramWebhook() {
  var token = getBotToken();
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN belum diatur.');
  var url = 'https://api.telegram.org/bot' + token + '/deleteWebhook';
  var resp = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  var result = JSON.parse(resp.getContentText());
  Logger.log(JSON.stringify(result));
  return result;
}

// Kirim Pesan HTML ke Telegram
function sendTelegramMessage(chatId, htmlText) {
  var token = getBotToken();
  if (!token) return;
  var url = 'https://api.telegram.org/bot' + token + '/sendMessage';
  var payload = {
    chat_id: chatId,
    text: htmlText,
    parse_mode: 'HTML',
    disable_web_page_preview: true
  };
  try {
    UrlFetchApp.fetch(url, {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });
  } catch (e) {
    Logger.log('Error sendTelegramMessage: ' + e);
  }
}

// --- ENDPOINT WEBHOOK TELEGRAM (doPost) ---
function doPost(e) {
  try {
    if (!e || !e.postData || !e.postData.contents) return ContentService.createTextOutput('OK');
    var update = JSON.parse(e.postData.contents);
    if (!update.message || !update.message.text) return ContentService.createTextOutput('OK');

    var msg = update.message;
    var chatId = String(msg.chat.id);
    var text = msg.text.trim();
    var allowedId = getAllowedChatId();

    // Validasi Pengguna (Keamanan Pribadi)
    if (allowedId && chatId !== String(allowedId).trim()) {
      sendTelegramMessage(chatId, '⛔ <b>Akses Ditolak:</b> Anda tidak diizinkan mengakses bot Arta pribadi ini.\nID Anda: <code>' + chatId + '</code>\nPastikan ID ini dimasukkan ke Script Properties <code>ALLOWED_TELEGRAM_USER_ID</code>.');
      return ContentService.createTextOutput('UNAUTHORIZED');
    }

    // Proteksi Konkurensi
    var lock = LockService.getScriptLock();
    if (!lock.tryLock(10000)) return ContentService.createTextOutput('BUSY');

    try {
      handleTelegramCommand(chatId, text);
    } finally {
      lock.releaseLock();
    }

  } catch (err) {
    Logger.log('Error doPost Telegram: ' + err.toString());
  }
  return ContentService.createTextOutput('OK');
}

// --- SMART PARSER NOMINAL (Mendukung 25k, 25rb, 1.5jt, 50.000, dll) ---
function parseNominal_(raw) {
  if (!raw) return 0;
  var s = String(raw).toLowerCase().trim().replace(/rp\.?/g, '').replace(/\s+/g, '');

  // Deteksi k / rb / ribu (ribu)
  if (s.endsWith('k') || s.endsWith('rb') || s.endsWith('ribu')) {
    var numK = parseFloat(s.replace(/(k|rb|ribu)$/g, '').replace(/,/g, '.'));
    return isNaN(numK) ? 0 : Math.round(numK * 1000);
  }

  // Deteksi jt / juta / m / mio (juta)
  if (s.endsWith('jt') || s.endsWith('juta') || s.endsWith('m') || s.endsWith('mio')) {
    var numJt = parseFloat(s.replace(/(jt|juta|m|mio)$/g, '').replace(/,/g, '.'));
    return isNaN(numJt) ? 0 : Math.round(numJt * 1000000);
  }

  // Format angka biasa (buang titik/koma pemisah ribuan)
  var clean = s.replace(/\./g, '').replace(/,/g, '');
  var val = Number(clean);
  return isNaN(val) ? 0 : val;
}

// --- SMART PARSER INPUT TRANSAKSI ---
function parseTxInput_(rawText) {
  var nominal = 0;
  var kategori = '';
  var deskripsi = '';

  // 1. Format jika memakai pemisah pipa '|'
  if (rawText.indexOf('|') !== -1) {
    var parts = rawText.split('|').map(function (p) { return p.trim(); });
    nominal = parseNominal_(parts[0]);
    kategori = parts[1] || '';
    deskripsi = parts.slice(2).join(' ') || '';
  }
  // 2. Format jika memakai koma ','
  else if (rawText.indexOf(',') !== -1) {
    var partsComma = rawText.split(',').map(function (p) { return p.trim(); });
    nominal = parseNominal_(partsComma[0]);
    kategori = partsComma[1] || '';
    deskripsi = partsComma.slice(2).join(' ') || '';
  }
  // 3. Format bebas menggunakan spasi (contoh: 25k Makanan Nasi Padang)
  else {
    var tokens = rawText.split(/\s+/).filter(Boolean);
    if (tokens.length >= 1) {
      nominal = parseNominal_(tokens[0]);
      kategori = tokens[1] || '';
      deskripsi = tokens.slice(2).join(' ') || '';
    }
  }

  return {
    nominal: nominal,
    kategori: kategori,
    deskripsi: deskripsi
  };
}

// --- PARSER PERINTAH BOT TELEGRAM ---
function handleTelegramCommand(chatId, text) {
  var formatIDR = function (num) {
    return 'Rp ' + Number(num || 0).toLocaleString('id-ID');
  };
  var todayStr = Utilities.formatDate(new Date(), 'Asia/Jakarta', 'yyyy-MM-dd');
  var currentMonthStr = todayStr.substring(0, 7);

  // Normalisasi command: ambil kata pertama, dukung baik dengan '/' maupun tanpa '/'
  var cleanText = text.trim();
  var firstSpace = cleanText.indexOf(' ');
  var rawCmd = (firstSpace === -1 ? cleanText : cleanText.substring(0, firstSpace)).toLowerCase();
  var cmd = rawCmd.startsWith('/') ? rawCmd : ('/' + rawCmd);
  var args = (firstSpace === -1 ? '' : cleanText.substring(firstSpace + 1)).trim();

  // /start atau /help atau /bantuan
  if (cmd === '/start' || cmd === '/help' || cmd === '/bantuan') {
    var helpMsg = '🍃 <b>Arta — Keuangan Lebih Terarah</b>\n\n' +
      'Catat keuangan langsung lewat pesan Telegram dengan perintah berikut:\n\n' +
      '🟢 <b>Catat Pemasukan:</b>\n' +
      '• <code>/pemasukan [Nominal] | [Kategori] | [Keterangan]</code>\n' +
      '  <i>Alias: /masuk</i>\n' +
      '  <i>Contoh:</i> <code>/pemasukan 500000 | Gaji | Bonus lembur</code>\n' +
      '  <i>Bisa cepat:</i> <code>/masuk 500k Gaji Bonus</code>\n\n' +
      '🔴 <b>Catat Pengeluaran:</b>\n' +
      '• <code>/pengeluaran [Nominal] | [Kategori] | [Keterangan]</code>\n' +
      '  <i>Alias: /keluar</i>\n' +
      '  <i>Contoh:</i> <code>/pengeluaran 25000 | Makan | Nasi Padang</code>\n' +
      '  <i>Bisa cepat:</i> <code>/keluar 25k Makan Nasi Padang</code>\n\n' +
      '📋 <b>Informasi & Anggaran:</b>\n' +
      '• <code>/saldo</code> — Cek saldo seluruh rekening\n' +
      '• <code>/ringkasan</code> — Rekap pemasukan, pengeluaran & sisa kas bulan ini\n' +
      '• <code>/anggaran</code> — Cek status batas anggaran bulanan\n' +
      '• <code>/anggaran [Kategori] | [Keterangan] | [Nominal]</code> — Atur anggaran dengan keterangan detail\n' +
      '  <i>Contoh:</i> <code>/anggaran Tagihan | Listrik PLN | 300k</code>\n' +
      '  <i>Contoh:</i> <code>/anggaran Makanan | 1.5jt</code>\n' +
      '• <code>/salinanggaran</code> — Salin anggaran aktif ke bulan berikutnya';
    sendTelegramMessage(chatId, helpMsg);
    return;
  }

  // /saldo
  if (cmd === '/saldo') {
    var ss = getArtaSpreadsheet_();
    var current = readSnapshot_(ss, 'personal');
    var state = current.state;

    var totalSaldo = 0;
    var reply = '💰 <b>SALDO REKENING ARTA</b>\n\n';

    (state.accounts || []).forEach(function (acc) {
      var inSum = 0;
      var outSum = 0;
      (state.transactions || []).forEach(function (tx) {
        if (tx.accountId === acc.id) {
          if (tx.type === 'income') inSum += Number(tx.amount || 0);
          else outSum += Number(tx.amount || 0);
        }
      });
      var curBal = (Number(acc.openingBalance) || 0) + inSum - outSum;
      totalSaldo += curBal;
      reply += '• <b>' + acc.name + ':</b> ' + formatIDR(curBal) + '\n';
    });

    reply += '━━━━━━━━━━━━━━━━━━━\n';
    reply += '💵 <b>TOTAL KEKAYAAN: ' + formatIDR(totalSaldo) + '</b>';
    sendTelegramMessage(chatId, reply);
    return;
  }

  // /salinanggaran atau /copyanggaran
  if (cmd === '/salinanggaran' || cmd === '/copyanggaran' || (cmd === '/anggaran' && args.toLowerCase().startsWith('salin'))) {
    var salinTokens = args ? args.replace(/^salin\s*/i, '').trim().split(/\s+/).filter(Boolean) : [];
    var srcMonth = currentMonthStr;
    var tgtMonth = getNextMonth_(srcMonth);

    if (salinTokens.length === 1 && /^\d{4}-\d{2}$/.test(salinTokens[0])) {
      tgtMonth = salinTokens[0];
    } else if (salinTokens.length >= 2 && /^\d{4}-\d{2}$/.test(salinTokens[0]) && /^\d{4}-\d{2}$/.test(salinTokens[1])) {
      srcMonth = salinTokens[0];
      tgtMonth = salinTokens[1];
    }

    var copyRes = copyBudgetsToNextMonth(srcMonth, tgtMonth, 'personal');
    if (!copyRes || !copyRes.success) {
      sendTelegramMessage(chatId, '⚠️ <b>Gagal Menyalin Anggaran:</b>\n\n' + (copyRes && copyRes.message ? copyRes.message : 'Pastikan sudah ada anggaran di bulan sumber.'));
      return;
    }

    var replyCopy = '📋 <b>ANGGARAN BERHASIL DISALIN!</b>\n\n' +
      '• <b>Dari Bulan:</b> ' + srcMonth + '\n' +
      '• <b>Ke Bulan:</b> ' + tgtMonth + '\n' +
      '• <b>Jumlah Kategori:</b> ' + copyRes.count + '\n' +
      '• <b>Total Alokasi:</b> ' + formatIDR(copyRes.totalLimit) + '\n\n' +
      '<b>Rincian Anggaran ' + tgtMonth + ':</b>\n';

    (copyRes.budgets || []).forEach(function (b, i) {
      var noteStr = b.note ? ' (' + b.note + ')' : '';
      replyCopy += (i + 1) + '. ' + b.category + noteStr + ': ' + formatIDR(b.limit) + '\n';
    });

    replyCopy += '\n✨ <i>Tersinkronisasi otomatis ke Google Sheets sheet "Pribadi — Anggaran"!</i>';
    sendTelegramMessage(chatId, replyCopy);
    return;
  }

  // /anggaran atau /budget
  if (cmd === '/anggaran' || cmd === '/budget') {
    // Cek jika argumen kosong ATAU berupa format bulan YYYY-MM
    var isPeriodQuery = !args || /^\d{4}-\d{2}$/.test(args);
    if (isPeriodQuery) {
      var targetPeriod = args ? args : currentMonthStr;
      var budgetList = getBudgets('personal', targetPeriod);
      if (budgetList.length === 0) {
        sendTelegramMessage(chatId, '📊 <b>Belum ada anggaran untuk periode ' + targetPeriod + '.</b>\n\n' +
          '• Ketik <code>/salinanggaran</code> untuk menyalin anggaran dari bulan sebelumnya.\n' +
          '• Atau atur anggaran baru:\n  <code>/anggaran Tagihan | Listrik PLN | 300k</code>\n  <code>/anggaran Makanan | 1.5jt</code>');
        return;
      }

      var reply = '📊 <b>STATUS ANGGARAN (' + targetPeriod + ')</b>\n\n';
      budgetList.forEach(function (bg, idx) {
        var catName = bg.category;
        var noteStr = bg.note ? ' (' + bg.note + ')' : '';
        var limit = Number(bg.limit) || 0;
        var spent = Number(bg.spent) || 0;
        var rem = limit - spent;
        var pct = bg.percent || 0;

        var icon = rem < 0 ? '🚨' : pct >= 80 ? '⚠️' : '✅';
        reply += (idx + 1) + '. <b>' + catName + noteStr + '</b>\n' +
          '   • Batas: ' + formatIDR(limit) + '\n' +
          '   • Terpakai: ' + formatIDR(spent) + ' (' + pct + '%)\n' +
          '   • Sisa: ' + formatIDR(rem) + ' ' + icon + '\n\n';
      });

      reply += '━━━━━━━━━━━━━━━━━━━\n' +
        '• <i>Ubah/tambah:</i> <code>/anggaran [Kategori] | [Keterangan] | [Nominal]</code>\n' +
        '• <i>Salin ke bulan berikutnya:</i> <code>/salinanggaran</code>';
      sendTelegramMessage(chatId, reply);
      return;
    }

    // Jika dengan argumen: Atur batas anggaran kategori & keterangan detail
    var bgCat = '';
    var bgNote = '';
    var bgLimit = 0;
    var specifiedPeriod = currentMonthStr;

    if (args.indexOf('|') !== -1) {
      var bgParts = args.split('|').map(function (p) { return p.trim(); }).filter(Boolean);
      if (bgParts.length >= 3) {
        // Format 3 bagian: Kategori | Keterangan | Nominal (atau variasinya)
        var n0 = parseNominal_(bgParts[0]);
        var n1 = parseNominal_(bgParts[1]);
        var n2 = parseNominal_(bgParts[2]);

        if (n2 > 0) {
          bgLimit = n2;
          bgCat = bgParts[0];
          bgNote = bgParts[1];
        } else if (n1 > 0) {
          bgLimit = n1;
          bgCat = bgParts[0];
          bgNote = bgParts[2];
        } else if (n0 > 0) {
          bgLimit = n0;
          bgCat = bgParts[1];
          bgNote = bgParts[2];
        }
      } else if (bgParts.length === 2) {
        // Format 2 bagian: Kategori | Nominal
        var testNum0 = parseNominal_(bgParts[0]);
        var testNum1 = parseNominal_(bgParts[1]);
        if (testNum0 > 0) {
          bgLimit = testNum0;
          bgCat = bgParts[1];
        } else {
          bgCat = bgParts[0];
          bgLimit = testNum1;
        }
      }
    } else {
      var tokens = args.split(/\s+/).filter(Boolean);
      var testT0 = parseNominal_(tokens[0]);
      var testTLast = parseNominal_(tokens[tokens.length - 1]);
      if (testT0 > 0) {
        bgLimit = testT0;
        var remWords = tokens.slice(1);
        if (remWords.length >= 2) {
          bgCat = remWords[0];
          bgNote = remWords.slice(1).join(' ');
        } else {
          bgCat = remWords.join(' ');
        }
      } else if (testTLast > 0) {
        bgLimit = testTLast;
        var remWords = tokens.slice(0, tokens.length - 1);
        if (remWords.length >= 2) {
          bgCat = remWords[0];
          bgNote = remWords.slice(1).join(' ');
        } else {
          bgCat = remWords.join(' ');
        }
      }
    }

    if (!bgCat || bgLimit <= 0) {
      sendTelegramMessage(chatId, '❌ <b>Format Anggaran Salah.</b>\n\n' +
        'Contoh dengan detail keterangan:\n' +
        '<code>/anggaran Tagihan | Listrik PLN | 300k</code>\n' +
        '<code>/anggaran Tagihan | Wifi Indihome | 350k</code>\n\n' +
        'Contoh umum:\n' +
        '<code>/anggaran Makanan | 1.5jt</code>\n' +
        '<code>/anggaran 500k Transportasi</code>');
      return;
    }

    var res = setBudget(bgCat, bgLimit, 'personal', specifiedPeriod, bgNote);
    if (res && res.success) {
      var noteLine = bgNote ? ('• <b>Keterangan:</b> ' + bgNote + '\n') : '';
      sendTelegramMessage(chatId, '🎯 <b>Anggaran Berhasil Disimpan!</b>\n\n' +
        '• <b>Kategori:</b> ' + bgCat + '\n' +
        noteLine +
        '• <b>Batas:</b> ' + formatIDR(bgLimit) + '\n' +
        '• <b>Periode:</b> ' + specifiedPeriod + '\n\n' +
        '<i>Tersinkronisasi otomatis ke Google Sheets "Pribadi — Anggaran" & Web App Arta!</i>');
    } else {
      sendTelegramMessage(chatId, '⚠️ Gagal menyimpan anggaran: ' + (res && res.message ? res.message : 'Kesalahan sistem.'));
    }
    return;
  }

  // /ringkasan atau /rekap
  if (cmd === '/ringkasan' || cmd === '/rekap') {
    var ss = getArtaSpreadsheet_();
    var current = readSnapshot_(ss, 'personal');
    var state = current.state;

    var totalMasuk = 0;
    var totalKeluar = 0;

    (state.transactions || []).forEach(function (tx) {
      if ((tx.date || '').startsWith(currentMonthStr)) {
        if (tx.type === 'income') totalMasuk += Number(tx.amount || 0);
        else totalKeluar += Number(tx.amount || 0);
      }
    });

    var net = totalMasuk - totalKeluar;
    var reply = '📊 <b>RINGKASAN ARUS KAS (' + currentMonthStr + ')</b>\n\n' +
      '• Total Pemasukan: ' + formatIDR(totalMasuk) + '\n' +
      '• Total Pengeluaran: ' + formatIDR(totalKeluar) + '\n' +
      '━━━━━━━━━━━━━━━━━━━\n' +
      '✨ <b>Sisa Kas Bersih: ' + (net >= 0 ? '+' : '') + formatIDR(net) + '</b>';
    sendTelegramMessage(chatId, reply);
    return;
  }

  // /pemasukan atau /masuk
  if (cmd === '/pemasukan' || cmd === '/masuk' || cmd === '/in' || cmd === '/income') {
    var parsed = parseTxInput_(args);
    if (!parsed.nominal || parsed.nominal <= 0) {
      sendTelegramMessage(chatId, '❌ <b>Format Pemasukan Salah.</b>\n\n' +
        'Format lengkap:\n<code>/pemasukan 500000 | Gaji | Bonus lembur</code>\n\n' +
        'Format cepat:\n<code>/masuk 500k Gaji Bonus lembur</code>\n' +
        'Atau tanpa kategori:\n<code>/masuk 500k</code>');
      return;
    }

    var katMasuk = parsed.kategori || 'Pendapatan';
    var descMasuk = parsed.deskripsi || 'Pemasukan via Telegram';

    var ss = getArtaSpreadsheet_();
    var accName = 'Kas';
    var currentBal = 0;

    withArtaLock_(function () {
      var current = readSnapshot_(ss, 'personal');
      var state = current.state;
      var targetAccount = (state.accounts && state.accounts.length > 0) ? state.accounts[0] : { id: 'cash', name: 'Kas Tunai' };
      accName = targetAccount.name;

      var newTx = {
        id: 'tx-' + new Date().getTime(),
        type: 'income',
        amount: parsed.nominal,
        date: todayStr,
        description: descMasuk,
        category: katMasuk,
        accountId: targetAccount.id
      };

      state.transactions.push(newTx);
      var newRev = (current.revision || 0) + 1;
      writeSnapshot_(ss, 'personal', JSON.stringify(state), newRev);
      projectSafely_(ss, 'personal', state);

      // Hitung saldo rekening terkait
      var inSum = 0, outSum = 0;
      state.transactions.forEach(function (tx) {
        if (tx.accountId === targetAccount.id) {
          if (tx.type === 'income') inSum += Number(tx.amount || 0);
          else outSum += Number(tx.amount || 0);
        }
      });
      currentBal = (Number(targetAccount.openingBalance) || 0) + inSum - outSum;
    });

    sendTelegramMessage(chatId, '🟢 <b>Pemasukan Berhasil Dicatat!</b>\n\n' +
      '• <b>Nominal:</b> ' + formatIDR(parsed.nominal) + '\n' +
      '• <b>Kategori:</b> ' + katMasuk + '\n' +
      '• <b>Keterangan:</b> ' + descMasuk + '\n' +
      '• <b>Rekening:</b> ' + accName + ' (Saldo: ' + formatIDR(currentBal) + ')\n\n' +
      '<i>Tersimpan otomatis ke Google Sheets & Web App Arta.</i>');
    return;
  }

  // /pengeluaran atau /keluar
  if (cmd === '/pengeluaran' || cmd === '/keluar' || cmd === '/out' || cmd === '/expense') {
    var parsedOut = parseTxInput_(args);
    if (!parsedOut.nominal || parsedOut.nominal <= 0) {
      sendTelegramMessage(chatId, '❌ <b>Format Pengeluaran Salah.</b>\n\n' +
        'Format lengkap:\n<code>/pengeluaran 25000 | Makanan | Nasi Padang</code>\n\n' +
        'Format cepat:\n<code>/keluar 25k Makan Nasi Padang</code>\n' +
        'Atau tanpa kategori:\n<code>/keluar 25k</code>');
      return;
    }

    var katKeluar = parsedOut.kategori || 'Lain-lain';
    var descKeluar = parsedOut.deskripsi || 'Pengeluaran via Telegram';

    var ss = getArtaSpreadsheet_();
    var accNameOut = 'Kas';
    var currentBalOut = 0;

    withArtaLock_(function () {
      var current = readSnapshot_(ss, 'personal');
      var state = current.state;
      var targetAccount = (state.accounts && state.accounts.length > 0) ? state.accounts[0] : { id: 'cash', name: 'Kas Tunai' };
      accNameOut = targetAccount.name;

      var newTx = {
        id: 'tx-' + new Date().getTime(),
        type: 'expense',
        amount: parsedOut.nominal,
        date: todayStr,
        description: descKeluar,
        category: katKeluar,
        accountId: targetAccount.id
      };

      state.transactions.push(newTx);
      var newRev = (current.revision || 0) + 1;
      writeSnapshot_(ss, 'personal', JSON.stringify(state), newRev);
      projectSafely_(ss, 'personal', state);

      // Hitung saldo rekening terkait
      var inSum = 0, outSum = 0;
      state.transactions.forEach(function (tx) {
        if (tx.accountId === targetAccount.id) {
          if (tx.type === 'income') inSum += Number(tx.amount || 0);
          else outSum += Number(tx.amount || 0);
        }
      });
      currentBalOut = (Number(targetAccount.openingBalance) || 0) + inSum - outSum;
    });

    sendTelegramMessage(chatId, '🔴 <b>Pengeluaran Berhasil Dicatat!</b>\n\n' +
      '• <b>Nominal:</b> ' + formatIDR(parsedOut.nominal) + '\n' +
      '• <b>Kategori:</b> ' + katKeluar + '\n' +
      '• <b>Keterangan:</b> ' + descKeluar + '\n' +
      '• <b>Rekening:</b> ' + accNameOut + ' (Sisa Saldo: ' + formatIDR(currentBalOut) + ')\n\n' +
      '<i>Tersimpan otomatis ke Google Sheets & Web App Arta.</i>');
    return;
  }

  // Pesan tidak dikenali
  sendTelegramMessage(chatId, '❓ Perintah tidak dikenali.\n\nKetik <code>/start</code> atau <code>/bantuan</code> untuk melihat panduan.');
}

// --- PEMBERSIH TRIGGER ---
function deleteDailyTriggers() {
  var triggers = ScriptApp.getProjectTriggers();
  triggers.forEach(function (t) {
    if (t.getHandlerFunction() === 'sendDailyNotifications') {
      ScriptApp.deleteTrigger(t);
    }
  });
  return { success: true, message: 'Trigger pengingat tagihan berhasil dihapus.' };
}
