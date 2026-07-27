import React, { useState } from 'react';
import { Card } from '../../ui';
import { ConfigTabProps, SectionHeading, CardHeading, FieldRow, ToggleSwitch, TravelIcon, inputCls, compactInputCls } from './shared';

export function TravelConfig({ getSetting, queueChange }: ConfigTabProps) {
  const emergencyDays = getSetting('travel', 'emergency_threshold_days', 7);
  const maxItineraryRows = getSetting('travel', 'max_itinerary_rows', 20);
  const requireConditionsAccept = getSetting('travel', 'require_conditions_accept', true);
  const [reqConditions, setReqConditions] = useState(requireConditionsAccept);

  const defaultLocations = [
    { code: 'MRC', name: 'Montclair Resort and Conferencing', city: 'Nyanga', enabled: true },
    { code: 'NAH', name: 'New Ambassador Hotel', city: 'Harare', enabled: true },
    { code: 'RTH', name: 'Rainbow Towers Hotel', city: 'Harare', enabled: true },
    { code: 'KHCC', name: 'KHCC Conference Centre', city: 'Kadoma', enabled: true },
    { code: 'BRH', name: 'Bulawayo Rainbow Hotel', city: 'Bulawayo', enabled: true },
    { code: 'VFRH', name: 'Victoria Falls Rainbow Hotel', city: 'Victoria Falls', enabled: true },
    { code: 'AZAM', name: "A'Zambezi River Lodge", city: 'Victoria Falls', enabled: true },
  ];

  const locations = getSetting('travel', 'locations', defaultLocations);
  const [locs, setLocs] = useState(Array.isArray(locations) ? locations : defaultLocations);

  const defaultDistances: Record<string, Record<string, number>> = {
    'RTH':  { 'RTH': 0, 'NAH': 2.1, 'KHCC': 139, 'BRH': 440, 'AZAM': 713, 'VFRH': 709, 'MRC': 272 },
    'NAH':  { 'RTH': 2.1, 'NAH': 0, 'KHCC': 136.9, 'BRH': 437.9, 'AZAM': 710.9, 'VFRH': 706.9, 'MRC': 269.9 },
    'KHCC': { 'RTH': 139, 'NAH': 140, 'KHCC': 0, 'BRH': 301, 'AZAM': 574, 'VFRH': 570, 'MRC': 133 },
    'BRH':  { 'RTH': 440, 'NAH': 437.9, 'KHCC': 301, 'BRH': 0, 'AZAM': 273, 'VFRH': 269, 'MRC': 168 },
    'AZAM': { 'RTH': 713, 'NAH': 710.9, 'KHCC': 574, 'BRH': 273, 'AZAM': 0, 'VFRH': 4, 'MRC': 441 },
    'VFRH': { 'RTH': 709, 'NAH': 706.9, 'KHCC': 570, 'BRH': 269, 'AZAM': 4, 'VFRH': 0, 'MRC': 437 },
    'MRC':  { 'RTH': 272, 'NAH': 269.9, 'KHCC': 133, 'BRH': 168, 'AZAM': 441, 'VFRH': 437, 'MRC': 0 },
  };

  const distances = getSetting('travel', 'distance_matrix', defaultDistances);
  const [matrix, setMatrix] = useState(typeof distances === 'object' && distances !== null ? distances : defaultDistances);

  const enabledCodes = locs.filter((l: any) => l.enabled).map((l: any) => l.code);

  const updateDistance = (from: string, to: string, value: number) => {
    const updated = JSON.parse(JSON.stringify(matrix));
    if (!updated[from]) updated[from] = {};
    if (!updated[to]) updated[to] = {};
    updated[from][to] = value;
    updated[to][from] = value;
    setMatrix(updated);
    queueChange('travel', 'distance_matrix', updated);
  };

  const toggleLocation = (index: number) => {
    const updated = [...locs];
    updated[index] = { ...updated[index], enabled: !updated[index].enabled };
    setLocs(updated);
    queueChange('travel', 'locations', updated);
  };

  // Cost allocation
  const defaultUnits = ['CORP', 'MRC', 'NAH', 'RTH', 'KHCC', 'BRH', 'VFRH', 'AZAM'];
  const costUnits = getSetting('travel', 'cost_allocation_units', defaultUnits);
  const [units, setUnits] = useState(Array.isArray(costUnits) ? costUnits.join(', ') : defaultUnits.join(', '));

  return (
    <div className="space-y-6 animate-fade-in">
      <SectionHeading title="Travel & Distance Configuration" subtitle="Manage business unit locations, inter-unit distances, and travel form rules." />

      <Card className="!p-6">
        <CardHeading icon={<svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" /></svg>} iconBg="bg-orange-100" iconColor="text-orange-600" title="Travel Rules" />
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
          <FieldRow label="Emergency travel threshold" unit="days">
            <input type="number" defaultValue={emergencyDays} onChange={(e) => queueChange('travel', 'emergency_threshold_days', Number(e.target.value))} className={compactInputCls} />
          </FieldRow>
          <FieldRow label="Max itinerary rows per request" unit="rows">
            <input type="number" defaultValue={maxItineraryRows} onChange={(e) => queueChange('travel', 'max_itinerary_rows', Number(e.target.value))} className={compactInputCls} />
          </FieldRow>
        </div>
        <ToggleSwitch
          checked={reqConditions}
          onChange={(v) => { setReqConditions(v); queueChange('travel', 'require_conditions_accept', v); }}
          label="Require acceptance of travel conditions"
          description="User must accept the RTG travel policy before submitting"
        />
      </Card>

      <Card className="!p-6">
        <CardHeading icon={<svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 11a3 3 0 11-6 0 3 3 0 016 0z" /></svg>} iconBg="bg-[#F3EADC]" iconColor="text-[#9A7545]" title="Business Unit Locations" />
        <p className="text-sm text-gray-500 mb-4">Toggle locations that appear in Travel Authorization and Hotel Booking itinerary dropdowns.</p>
        <div className="space-y-2">
          {locs.map((loc: any, i: number) => (
            <div key={loc.code} className={`flex items-center justify-between p-3 rounded-lg border transition-colors ${loc.enabled ? 'bg-white border-gray-200' : 'bg-gray-50 border-gray-100 opacity-60'}`}>
              <div className="flex items-center gap-3">
                <span className="text-xs font-bold text-gray-400 w-12">{loc.code}</span>
                <div>
                  <p className="text-sm font-medium text-gray-900">{loc.name}</p>
                  <p className="text-xs text-gray-500">{loc.city}</p>
                </div>
              </div>
              <label className="relative inline-flex items-center cursor-pointer">
                <input type="checkbox" className="sr-only peer" checked={loc.enabled} onChange={() => toggleLocation(i)} />
                <div className="w-9 h-5 bg-gray-200 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-[#9A7545]"></div>
              </label>
            </div>
          ))}
        </div>
      </Card>

      <Card className="!p-6">
        <CardHeading icon={<TravelIcon />} iconBg="bg-teal-100" iconColor="text-teal-600" title="Inter-Unit Distance Matrix (KM)" />
        <p className="text-sm text-gray-500 mb-4">Edit distances between enabled locations. These auto-populate the itinerary KM field.</p>
        <div className="overflow-x-auto">
          <table className="text-xs border-collapse w-full">
            <thead>
              <tr>
                <th className="p-2 text-left font-semibold text-gray-600 border-b border-gray-200">From / To</th>
                {enabledCodes.map((c: string) => (
                  <th key={c} className="p-2 text-center font-semibold text-gray-600 border-b border-gray-200 min-w-[60px]">{c}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {enabledCodes.map((from: string) => (
                <tr key={from}>
                  <td className="p-2 font-semibold text-gray-700 border-b border-gray-100">{from}</td>
                  {enabledCodes.map((to: string) => (
                    <td key={to} className="p-1 border-b border-gray-100 text-center">
                      {from === to ? (
                        <span className="text-gray-300">&mdash;</span>
                      ) : (
                        <input
                          type="number"
                          step="0.1"
                          className="w-16 px-1 py-1 text-xs text-center rounded border border-gray-200 focus:ring-1 focus:ring-brand-500"
                          defaultValue={matrix[from]?.[to] || 0}
                          onChange={(e) => updateDistance(from, to, parseFloat(e.target.value) || 0)}
                        />
                      )}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Card className="!p-6">
        <CardHeading icon={<svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M11 3.055A9.001 9.001 0 1020.945 13H11V3.055z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M20.488 9H15V3.512A9.025 9.025 0 0120.488 9z" /></svg>} iconBg="bg-pink-100" iconColor="text-pink-600" title="Cost Allocation Units" />
        <p className="text-sm text-gray-500 mb-4">Business units used in the cost allocation split on travel forms. Comma-separated codes.</p>
        <div className="space-y-1">
          <label className="text-sm font-medium text-gray-700">Allocation Unit Codes</label>
          <input
            type="text"
            value={units}
            onChange={(e) => {
              setUnits(e.target.value);
              queueChange('travel', 'cost_allocation_units', e.target.value.split(',').map((s: string) => s.trim()).filter(Boolean));
            }}
            className={inputCls}
          />
        </div>
      </Card>
    </div>
  );
}
