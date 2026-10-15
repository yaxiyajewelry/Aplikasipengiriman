import { db, SyncTask, getCurrentDateFormatted } from './db.js';
import { googleSheetsClient } from './googleSheets.js';

class SyncService {
  private isProcessing = false;
  private intervalId: NodeJS.Timeout | null = null;

  public start() {
    if (this.intervalId) return;
    console.log('[SyncService] Background sync service running...');
    
    // Initial sync trigger after 3 seconds
    setTimeout(() => {
      this.processQueue().catch(err => console.error('[SyncService] Initial sync error:', err.message));
    }, 3000);

    // Periodically run every 25 seconds
    this.intervalId = setInterval(() => {
      this.processQueue().catch(err => {
        // Silently capture background interval errors without crashing
      });
    }, 25000);
  }

  public stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  public async processQueue(): Promise<{ processed: number; errors: number }> {
    if (this.isProcessing) {
      return { processed: 0, errors: 0 };
    }

    const tasks = db.getPendingSyncTasks();
    if (tasks.length === 0) {
      return { processed: 0, errors: 0 };
    }

    this.isProcessing = true;
    let processed = 0;
    let errors = 0;

    const appsScriptUrl = db.getAppsScriptUrl();

    // 1. If Apps Script Web App URL is configured, prefer sync via Apps Script (zero config, works anywhere)
    if (appsScriptUrl) {
      try {
        for (const task of tasks) {
          if (task.retry_count >= 5) continue;
          try {
            await this.syncTaskToAppsScript(appsScriptUrl, task);
            db.updateSyncTask(task.sync_id, 'SYNCED', null);
            processed++;
          } catch (taskErr: any) {
            errors++;
            db.updateSyncTask(task.sync_id, 'FAILED', taskErr.message);
          }
        }
        return { processed, errors };
      } catch (e: any) {
        console.warn('[SyncService] Apps Script sync failed:', e.message);
      } finally {
        this.isProcessing = false;
      }
    }

    // 2. Otherwise fallback to Google Service Account client
    try {
      // Ensure sheets & headers are initialized first
      await googleSheetsClient.ensureSheetsInitialized();

      for (const task of tasks) {
        // Max retry 5 attempts before backing off
        if (task.retry_count >= 5) {
          continue;
        }

        try {
          await this.syncSingleTask(task);
          db.updateSyncTask(task.sync_id, 'SYNCED', null);
          processed++;

          // Also record sync into LOG_SINKRONISASI sheet
          try {
            await googleSheetsClient.appendRow('LOG_SINKRONISASI', [
              task.sync_id,
              task.entity_type,
              task.entity_id,
              task.operation,
              'SUCCESS',
              '',
              task.created_at,
              getCurrentDateFormatted()
            ]);
          } catch (logErr) {
            // Ignore sheet logging error
          }
        } catch (err: any) {
          errors++;
          const errorMsg = err.message || String(err);
          db.updateSyncTask(task.sync_id, 'FAILED', errorMsg);
          console.warn(`[SyncService] Gagal sinkronisasi task ${task.sync_id}:`, errorMsg);

          try {
            await googleSheetsClient.appendRow('LOG_SINKRONISASI', [
              task.sync_id,
              task.entity_type,
              task.entity_id,
              task.operation,
              'FAILED',
              errorMsg,
              task.created_at,
              getCurrentDateFormatted()
            ]);
          } catch {}
        }
      }
    } catch (globalErr: any) {
      console.warn('[SyncService] Google Sheets tidak dapat dijangkau saat ini:', globalErr.message);
      // We do not increment individual task retry if the whole connection failed
    } finally {
      this.isProcessing = false;
    }

    return { processed, errors };
  }

  private async syncSingleTask(task: SyncTask): Promise<void> {
    const payload = task.payload;

    if (task.entity_type === 'PELANGGAN') {
      const c = payload;
      const row = [
        c.customer_id,
        c.customer_name,
        c.primary_phone,
        c.notes || '',
        c.created_at,
        c.updated_at,
        c.status
      ];
      await googleSheetsClient.upsertRow('PELANGGAN', c.customer_id, row);
    } 
    else if (task.entity_type === 'ALAMAT_PENGIRIMAN') {
      const a = payload;
      const row = [
        a.address_id,
        a.customer_id,
        a.address_label,
        a.recipient_name,
        a.recipient_phone,
        a.full_address,
        a.village || '',
        a.district || '',
        a.city,
        a.province,
        a.postal_code || '',
        a.shipping_courier || '',
        a.shipping_service || '',
        a.shipping_notes || '',
        a.created_at,
        a.updated_at,
        a.status
      ];
      await googleSheetsClient.upsertRow('ALAMAT_PENGIRIMAN', a.address_id, row);
    }
    else if (task.entity_type === 'JASA_KIRIM') {
      const k = payload;
      const row = [
        k.courier_id,
        k.courier_name,
        k.courier_category,
        Array.isArray(k.services) ? k.services.join(', ') : (k.services || ''),
        k.is_favorite ? 'YA' : 'TIDAK',
        k.is_active ? 'AKTIF' : 'NONAKTIF',
        k.created_at,
        k.updated_at
      ];
      await googleSheetsClient.upsertRow('JASA_KIRIM', k.courier_id, row);
    }
    else if (task.entity_type === 'RIWAYAT_CETAK') {
      const p = payload;
      const row = [
        p.print_id,
        p.customer_id,
        p.address_id,
        p.recipient_name,
        p.shipping_courier,
        p.label_format,
        p.copies,
        p.printed_at
      ];
      await googleSheetsClient.appendRow('RIWAYAT_CETAK', row);
    }
  }

  private async syncTaskToAppsScript(url: string, task: SyncTask): Promise<void> {
    let action = 'saveCustomer';
    let bodyData: any = {};

    if (task.entity_type === 'PELANGGAN') {
      action = task.operation === 'DELETE' ? 'deleteCustomer' : 'saveCustomer';
      bodyData = { customer: task.payload, customer_id: task.entity_id, status: task.payload?.status };
    } else if (task.entity_type === 'ALAMAT_PENGIRIMAN') {
      action = task.operation === 'DELETE' ? 'deleteAddress' : 'saveAddress';
      bodyData = { address: task.payload, address_id: task.entity_id, status: task.payload?.status };
    } else if (task.entity_type === 'RIWAYAT_CETAK') {
      action = 'recordPrint';
      bodyData = { record: task.payload };
    }

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, ...bodyData }),
      redirect: 'follow'
    });
    const json = await res.json();
    if (!json.success) throw new Error(json.error || 'Apps script returned error');
  }
}

export const syncService = new SyncService();
