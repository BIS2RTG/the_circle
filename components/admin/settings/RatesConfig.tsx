import React from 'react';
import { Card } from '../../ui';
import { ConfigTabProps, SectionHeading, CardHeading, RateInput } from './shared';

export function RatesConfig({ getSetting, queueChange }: ConfigTabProps) {
  return (
    <div className="space-y-6 animate-fade-in">
      <SectionHeading title="Financial Rates & Limits" subtitle="AA reimbursement rates and fuel prices propagate automatically to the Travel Authorization and Hotel Booking forms." />

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card className="!p-6">
          <CardHeading icon={<svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M13 10V3L4 14h7v7l9-11h-7z" /></svg>} iconBg="bg-green-100" iconColor="text-green-600" title="AA Rates - Petrol (USD/km)" />
          <div className="space-y-3">
            <RateInput label="1.1L - 1.5L" value={getSetting('rates', 'aa_petrol_1500', '0.30')} unit="$/km" onChange={(v) => queueChange('rates', 'aa_petrol_1500', v)} />
            <RateInput label="1.6L - 2.0L" value={getSetting('rates', 'aa_petrol_2000', '0.38')} unit="$/km" onChange={(v) => queueChange('rates', 'aa_petrol_2000', v)} />
            <RateInput label="2.1L - 3.0L" value={getSetting('rates', 'aa_petrol_3000', '0.52')} unit="$/km" onChange={(v) => queueChange('rates', 'aa_petrol_3000', v)} />
            <RateInput label="Above 3.0L" value={getSetting('rates', 'aa_petrol_above3000', '0.64')} unit="$/km" onChange={(v) => queueChange('rates', 'aa_petrol_above3000', v)} />
          </div>
        </Card>

        <Card className="!p-6">
          <CardHeading icon={<svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M13 10V3L4 14h7v7l9-11h-7z" /></svg>} iconBg="bg-emerald-100" iconColor="text-emerald-600" title="AA Rates - Diesel (USD/km)" />
          <div className="space-y-3">
            <RateInput label="1.1L - 1.5L" value={getSetting('rates', 'aa_diesel_1500', '0.28')} unit="$/km" onChange={(v) => queueChange('rates', 'aa_diesel_1500', v)} />
            <RateInput label="1.6L - 2.0L" value={getSetting('rates', 'aa_diesel_2000', '0.34')} unit="$/km" onChange={(v) => queueChange('rates', 'aa_diesel_2000', v)} />
            <RateInput label="2.1L - 3.0L" value={getSetting('rates', 'aa_diesel_3000', '0.48')} unit="$/km" onChange={(v) => queueChange('rates', 'aa_diesel_3000', v)} />
            <RateInput label="Above 3.0L" value={getSetting('rates', 'aa_diesel_above3000', '0.59')} unit="$/km" onChange={(v) => queueChange('rates', 'aa_diesel_above3000', v)} />
          </div>
        </Card>

        <Card className="!p-6 lg:col-span-2">
          <CardHeading icon={<svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4" /></svg>} iconBg="bg-[#F3EADC]" iconColor="text-[#9A7545]" title="Fuel Pump Prices" />
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <RateInput label="Petrol (Blend)" value={getSetting('rates', 'fuel_petrol', '1.93')} unit="$/L" onChange={(v) => queueChange('rates', 'fuel_petrol', v)} />
            <RateInput label="Diesel" value={getSetting('rates', 'fuel_diesel', '1.87')} unit="$/L" onChange={(v) => queueChange('rates', 'fuel_diesel', v)} />
          </div>
          <p className="text-xs text-gray-400 mt-3 pt-3 border-t border-gray-100">Used in Travel Authorization budget calculations.</p>
        </Card>
      </div>
    </div>
  );
}
