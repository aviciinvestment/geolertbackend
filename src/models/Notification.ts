import mongoose, { Document, Schema } from 'mongoose';

export interface INotification extends Document {
  recipientId: mongoose.Types.ObjectId;
  senderId?: mongoose.Types.ObjectId;
  senderName: string;
  message: string;
  type: string;
  read: boolean;
  category?: string;
  severity?: number;
  reelId?: string;
  locationLabel?: string;
  createdAt: Date;
}

const NotificationSchema: Schema = new Schema(
  {
    recipientId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    senderId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    senderName: { type: String, default: '' },
    message: { type: String, required: true },
    type: { type: String, default: 'broadcast' },
    read: { type: Boolean, default: false },
    category: { type: String },
    severity: { type: Number },
    reelId: { type: String },
    locationLabel: { type: String },
  },
  { timestamps: true }
);

NotificationSchema.index({ recipientId: 1, read: 1, createdAt: -1 });

export const Notification = mongoose.model<INotification>(
  'Notification',
  NotificationSchema
);