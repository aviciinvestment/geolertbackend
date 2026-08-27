import { Request, Response } from 'express';
import { Notification } from '../models/Notification';
import { User } from '../models/User';
import { getSubordinateUsers } from '../services/hierarchy.service';
import { io } from '../server';

// POST /api/broadcast  body: { message: string, targetId?: string }
// Admin → broadcasts to one Authority Responder (or all under them).
// Super Admin → broadcasts to one Local Admin (or all under them).
export const sendBroadcast = async (req: Request, res: Response): Promise<void> => {
  try {
    const senderId = (req as any).user.id;
    const senderRole = (req as any).user.role;

    const message = typeof req.body.message === 'string' ? req.body.message.trim() : '';
    const targetId = typeof req.body.targetId === 'string' ? req.body.targetId : undefined;

    if (!message) {
      res.status(400).json({ success: false, message: 'A broadcast message is required' });
      return;
    }
    if (message.length > 2000) {
      res.status(400).json({ success: false, message: 'Broadcast message is too long (max 2000 characters)' });
      return;
    }

    const sender = await User.findById(senderId).select('name role jurisdiction').lean();
    const recipients = await getSubordinateUsers(sender as any);
    if (recipients.length === 0) {
      res.status(400).json({
        success: false,
        message:
          senderRole === 'admin'
            ? 'No approved authority responders are available under you to notify'
            : 'No approved local admins are available under you to notify',
      });
      return;
    }

    let targets: any[] = recipients;
    if (targetId) {
      const target = recipients.find((r) => String(r._id) === targetId);
      if (!target) {
        res.status(400).json({ success: false, message: 'Unknown or unauthorized recipient' });
        return;
      }
      targets = [target];
    }

    const senderName = sender?.name || '';
    const now = new Date();
    const notifications = targets.map((t) => ({
      recipientId: t._id,
      senderId,
      senderName,
      message,
      type: 'broadcast',
      read: false,
      createdAt: now,
    }));
    const saved = await Notification.insertMany(notifications);

    for (let i = 0; i < targets.length; i++) {
      const targetIdStr = String(targets[i]._id);
      io.to(`user:${targetIdStr}`).emit('notification', {
        id: String(saved[i]._id),
        senderId,
        senderName,
        message,
        type: 'broadcast',
        createdAt: now,
      });
    }

    res.status(200).json({
      success: true,
      sent: targets.length,
      recipients: targets.map((t) => ({ id: String(t._id), name: t.name })),
    });
  } catch (error) {
    console.error('Broadcast error:', error);
    res.status(500).json({ success: false, message: 'Failed to send broadcast' });
  }
};

export default { sendBroadcast };