/**
 * ARTA — HENTIKAN WEBHOOK & BERSIHKAN ANTREAN
 */

// 1. Matikan Webhook Telegram sepenuhnya sekarang juga
function stopWebhook() {
  var token = PropertiesService.getScriptProperties().getProperty('TELEGRAM_BOT_TOKEN');
  if (!token) throw new Error('Token bot belum ada');
  
  // Hapus webhook dan buang semua antrean pending updates
  var url = 'https://api.telegram.org/bot' + token + '/deleteWebhook?drop_pending_updates=true';
  var resp = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  Logger.log('Hentikan Webhook Result: ' + resp.getContentText());
  
  // Cek konfirmasi status
  var infoUrl = 'https://api.telegram.org/bot' + token + '/getWebhookInfo';
  var infoResp = UrlFetchApp.fetch(infoUrl, { muteHttpExceptions: true });
  Logger.log('Status Terkini: ' + infoResp.getContentText());
  return JSON.parse(resp.getContentText());
}
