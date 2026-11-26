import * as service from './service.js';

// GET /api/notifications
export async function listNotifications(req, res) {
  res.json(await service.listNotifications(req.user, req.input.query));
}

// GET /api/notifications/unread-count
export async function unreadCount(req, res) {
  res.json({ unreadCount: await service.unreadCount(req.user) });
}

// POST /api/notifications/:id/read
export async function markRead(req, res) {
  res.json(await service.markRead(req.user, req.input.params.id));
}

// POST /api/notifications/read-all
export async function markAllRead(req, res) {
  res.json(await service.markAllRead(req.user));
}
