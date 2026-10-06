import { NextApiRequest, NextApiResponse } from 'next';
import { getServerSession } from 'next-auth';
import { authOptions } from '../auth/[...nextauth]';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

// Public (authenticated) read-only view of the AA reimbursement rates and fuel
// pump prices that administrators manage in Admin → Financial Rates. The admin
// settings endpoint is gated on ADMIN_SYSTEM_CONFIG; ordinary employees filling
// in a Travel Authorization / Hotel Booking form still need these figures, so
// this endpoint exposes only the non-sensitive rate values.
//
// Defaults mirror the AA Zimbabwe "Estimated Vehicle Operating Costs" schedule
// (wet rate / COST per km, USD) and are used whenever an administrator has not
// overridden a given key. Engine-size buckets map to the AA vehicle classes:
//   1.1L–1.5L → Light (up to 1500cc)   1.6L–2.0L → Medium (1501–2000cc)
//   2.1L–3.0L → Large (2001–3000cc)    Above 3.0L → Luxury (over 3000cc)
// Source: AA Zimbabwe schedule "OCTOBER 2026" (version V322), wet rates.
const DEFAULTS: Record<string, number> = {
  aa_petrol_1500: 0.31, aa_diesel_1500: 0.29,
  aa_petrol_2000: 0.40, aa_diesel_2000: 0.36,
  aa_petrol_3000: 0.54, aa_diesel_3000: 0.50,
  aa_petrol_above3000: 0.66, aa_diesel_above3000: 0.62,
  fuel_petrol: 2.06, fuel_diesel: 2.08,
};

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const session = await getServerSession(req, res, authOptions);
  if (!session?.user?.id) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const orgId = (session.user as any).org_id;
  const map: Record<string, number> = { ...DEFAULTS };

  try {
    if (orgId) {
      const { data, error } = await supabaseAdmin
        .from('system_settings')
        .select('key, value')
        .eq('organization_id', orgId)
        .eq('category', 'rates');

      if (error) {
        console.error('Error fetching rate settings:', error);
      } else {
        (data || []).forEach((row: any) => {
          if (row.key in map) {
            const n = parseFloat(row.value);
            if (!Number.isNaN(n)) map[row.key] = n;
          }
        });
      }
    }
  } catch (err) {
    // Non-fatal: fall back to defaults so the forms always render.
    console.error('Error in rates GET:', err);
  }

  return res.status(200).json({
    aa: {
      '1.1L-1.5L': { petrol: map.aa_petrol_1500, diesel: map.aa_diesel_1500 },
      '1.6L-2.0L': { petrol: map.aa_petrol_2000, diesel: map.aa_diesel_2000 },
      '2.1L-3.0L': { petrol: map.aa_petrol_3000, diesel: map.aa_diesel_3000 },
      'Above 3.0L': { petrol: map.aa_petrol_above3000, diesel: map.aa_diesel_above3000 },
    },
    fuel: { petrol: map.fuel_petrol, diesel: map.fuel_diesel },
  });
}
