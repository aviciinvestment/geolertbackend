import mongoose, { Document, Schema } from 'mongoose';

export interface IComment extends Document {
  reelId: mongoose.Types.ObjectId;
  username: string;
  avatar: string;
  text: string;
  videoUrl?: string;
  createdAt: Date;
}

const CommentSchema: Schema = new Schema({
  reelId: { type: Schema.Types.ObjectId, ref: 'Reel', required: true, index: true },
  username: { type: String, required: true },
  avatar: { type: String, required: true, default: 'https://i.pravatar.cc/150' },
  text: { type: String, default: '' },
  videoUrl: { type: String, default: null },
  createdAt: { type: Date, default: Date.now }
});

export default mongoose.model<IComment>('Comment', CommentSchema);
