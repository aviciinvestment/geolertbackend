/**
 * Hierarchy service.
 * Resolves the chain of command for broadcasts and member listings:
 *   Super Admin -> Local Admins (approved, within the same state)
 *   Local Admin  -> Authority Responders (approved, within the same LGA)
 */

import { User } from '../models/User';
import { expandRegionName, expandLgaName } from './geo.service';

export interface AccountLike {
  _id: any;
  role?: string;
  jurisdiction?: { country?: string; state?: string; lga?: string };
}

/**
 * Approved users directly under `me` in the command chain.
 * Returns lean User documents (name/email/avatar/jurisdiction/role only).
 */
export async function getSubordinateUsers(me: AccountLike): Promise<any[]> {
  if (me?.role === 'superadmin') {
    const states = expandRegionName(me.jurisdiction?.state);
    return User.find({
      role: 'admin',
      authorizationStatus: 'approved',
      $or: [
        { authorizedBy: me._id },
        ...(states.length > 0 ? [{ 'jurisdiction.state': { $in: states } }] : []),
      ],
    })
      .select('name email avatar jurisdiction role specialization')
      .sort({ name: 1 })
      .lean();
  }

  if (me?.role === 'admin') {
    const states = expandRegionName(me.jurisdiction?.state);
    const lgas = expandLgaName(me.jurisdiction?.lga);
    return User.find({
      role: 'authority',
      authorizationStatus: 'approved',
      $or: [
        { authorizedBy: me._id },
        ...(states.length > 0 && lgas.length > 0
          ? [{ 'jurisdiction.state': { $in: states }, 'jurisdiction.lga': { $in: lgas } }]
          : []),
      ],
    })
      .select('name email avatar jurisdiction role specialization')
      .sort({ name: 1 })
      .lean();
  }

  return [];
}