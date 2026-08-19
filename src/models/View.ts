import mongoose, { Document, Schema } from 'mongoose';

export interface IView extends Document {
  reelId: mongoose.Types.ObjectId;
  userId: mongoose.Types.ObjectId;
  createdAt: Date;
}

const ViewSchema: Schema = new Schema({
  reelId: { type: Schema.Types.ObjectId, ref: 'Reel', required: true },
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  createdAt: { type: Date, default: Date.now },
});

ViewSchema.index({ reelId: 1, userId: 1 }, { unique: true });

export default mongoose.model<IView>('View', ViewSchema);
