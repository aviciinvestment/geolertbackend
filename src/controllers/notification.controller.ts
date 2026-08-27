import { Request, Response } from 'express';
import { Notification } from '../models/Notification';

// GET /api/notifications?limit=50
// Most recent notifications (broadcasts + routed incident alerts) for the
// signed-in user. Anything persisted survives page reloads / offline gaps.
export const getNotifications = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = (req as any).user.id;
    const requested = parseInt(String(req.query.limit ?? '50'), 10);
    const limit = Number.isFinite(requested) ? Math.min(Math.max(requested, 1), 100) : 50;

    const items = await Notification.find({ recipientId: userId })
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();

    res.status(200).json({
      success: true,
      data: items.map((n) => ({
        id: String(n._id),
        senderName: n.senderName,
        senderId: n.senderId ? String(n.senderId) : undefined,
        message: n.message,
        type: n.type,
        category: n.category,
        severity: n.severity,
        reelId: n.reelId,
        locationLabel: n.locationLabel,
        read: n.read,
        createdAt: n.createdAt,
      })),
    });
  } catch (error) {
    console.error('Get notifications error:', error);
    res.status(500).json({ success: false, message: 'Failed to load notifications' });
  }
};

// PUT /api/notifications/read — mark every outstanding notification as read
export const markAllRead = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = (req as any).user.id;
    await Notification.updateMany(
      { recipientId: userId, read: false },
      { $set: { read: true } }
    );
    res.status(200).json({ success: true });
  } catch (error) {
    console.error('Mark notifications read error:', error);
    res.status(500).json({ success: false, message: 'Failed to update notifications' });
  }
};

export default { getNotifications, markAllRead };