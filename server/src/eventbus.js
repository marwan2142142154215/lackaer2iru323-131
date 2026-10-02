// Event bus in-process sederhana (EventEmitter). Dipakai untuk:
//  - notifikasi dashboard via SSE
//  - alert Telegram (geofence, tamper, offline)
import { EventEmitter } from 'node:events';

class Bus extends EventEmitter {
  emitSafe(event, data) {
    try {
      this.emit(event, data);
    } catch (e) {
      // listener tidak boleh membuat proses mati
      this.emit('listener-error', { event, error: e.message });
    }
  }
}

export const bus = new Bus();
bus.setMaxListeners(100);

// Nama event yang dipakai (kontrak internal):
//  'device-online'    { deviceId, nama, at }
//  'device-offline'  { deviceId, nama, lastSeenAt }
//  'device-status'   { deviceId, patch }        (heartbeat/stokol berubah)
//  'device-event'    { deviceId, event, severity, detail }
//  'device-location' { deviceId, lat, lng, breach, dist }
//  'command-update'  { id, deviceId, status }
//  'media'           { id, deviceId, kind }
//  'log'             { level, text }
