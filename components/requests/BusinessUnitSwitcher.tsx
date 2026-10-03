import { useUserHrimsProfile } from '@/hooks/useUserHrimsProfile';

/**
 * "Filing for" business-unit picker for users who work across more than one
 * unit (Multi-Unit Requester role; see lib/requestBusinessUnits). Renders
 * nothing for everyone else.
 * The choice feeds useUserHrimsProfile, so the open form's requestor details
 * and approver resolution switch to the selected unit.
 */
export default function BusinessUnitSwitcher() {
  const { businessUnitOptions, businessUnitCode, setSelectedBusinessUnit } = useUserHrimsProfile();

  if (businessUnitOptions.length < 2) return null;

  return (
    <div className="mx-4 mt-4 sm:mx-6 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-4">
      <div className="flex-1">
        <p className="text-sm font-semibold text-amber-900">Which business unit is this request for?</p>
        <p className="text-xs text-amber-800">You work across more than one unit — the form and its approvers follow the unit you select.</p>
      </div>
      <select
        aria-label="Business unit for this request"
        value={businessUnitCode || ''}
        onChange={(e) => setSelectedBusinessUnit(e.target.value)}
        className="rounded-lg border border-amber-300 bg-white px-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-amber-400"
      >
        {businessUnitOptions.map((bu) => (
          <option key={bu.code} value={bu.code}>{bu.name}</option>
        ))}
      </select>
    </div>
  );
}
