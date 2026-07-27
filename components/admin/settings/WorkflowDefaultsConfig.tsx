import React, { useState } from 'react';
import { Card } from '../../ui';
import { ConfigTabProps, SectionHeading, CardHeading, ToggleSwitch, WorkflowIcon, RatesIcon, TravelIcon, inputCls, selectCls } from './shared';

export function WorkflowDefaultsConfig({ getSetting, queueChange }: ConfigTabProps) {
  const [parallel, setParallel] = useState(getSetting('workflows', 'allow_parallel_approvals', false));
  const [allParallel, setAllParallel] = useState(getSetting('workflows', 'require_all_parallel', true));
  const [skip, setSkip] = useState(getSetting('workflows', 'allow_skip_steps', false));
  const [reassign, setReassign] = useState(getSetting('workflows', 'allow_reassignment', true));
  const [withdraw, setWithdraw] = useState(getSetting('workflows', 'allow_withdraw', true));
  const [notifyEach, setNotifyEach] = useState(getSetting('workflows', 'notify_requester_on_each_step', true));
  const [reqComment, setReqComment] = useState(getSetting('workflows', 'default_require_comment', false));
  const [requireAttachments, setRequireAttachments] = useState(getSetting('workflows', 'require_attachments', false));
  const expirationDays = getSetting('workflows', 'expiration_days', 30);
  const onExpiration = getSetting('workflows', 'on_expiration', 'escalate');
  const escalationHours = getSetting('workflows', 'default_escalation_hours', 24);

  // CAPEX approval chain
  const defaultCapexRoles = [
    { key: 'finance_manager', label: 'Finance Manager / Accountant', description: 'Financial Review' },
    { key: 'general_manager', label: 'General Manager (Unit)', description: 'Unit Approval' },
    { key: 'procurement_manager', label: 'Procurement and Projects Manager', description: 'Procurement & Projects Review' },
    { key: 'corporate_hod', label: 'Corporate Head of Dept', description: 'Department Approval' },
    { key: 'managing_director', label: 'Managing Director', description: 'Operations Approval' },
    { key: 'finance_director', label: 'Finance Director', description: 'Final Financial Approval' },
    { key: 'ceo', label: 'Chief Executive', description: 'Final Authorization' },
  ];
  const capexRoles = getSetting('workflows', 'capex_approval_roles', defaultCapexRoles);
  const [cRoles, setCRoles] = useState(Array.isArray(capexRoles) ? capexRoles : defaultCapexRoles);

  // Travel approval chain
  const defaultTravelRoles = [
    { key: 'line_manager', label: 'Line Manager', description: 'Recommendation' },
    { key: 'functional_head', label: 'Functional Head', description: 'Functional Approval' },
    { key: 'hrd', label: 'Chief Human Capital Officer', description: 'CHCO Approval' },
    { key: 'ceo', label: 'Chief Executive Officer', description: 'Authorisation' },
  ];
  const travelRoles = getSetting('workflows', 'travel_approval_roles', defaultTravelRoles);
  const [tRoles, setTRoles] = useState(Array.isArray(travelRoles) ? travelRoles : defaultTravelRoles);

  const updateCapexRole = (index: number, field: string, value: string) => {
    const updated = [...cRoles];
    updated[index] = { ...updated[index], [field]: value };
    setCRoles(updated);
    queueChange('workflows', 'capex_approval_roles', updated);
  };
  const updateTravelRole = (index: number, field: string, value: string) => {
    const updated = [...tRoles];
    updated[index] = { ...updated[index], [field]: value };
    setTRoles(updated);
    queueChange('workflows', 'travel_approval_roles', updated);
  };
  const addCapexRole = () => {
    const updated = [...cRoles, { key: `role_${cRoles.length + 1}`, label: 'New Role', description: 'Description' }];
    setCRoles(updated);
    queueChange('workflows', 'capex_approval_roles', updated);
  };
  const removeCapexRole = (index: number) => {
    const updated = cRoles.filter((_: any, i: number) => i !== index);
    setCRoles(updated);
    queueChange('workflows', 'capex_approval_roles', updated);
  };
  const addTravelRole = () => {
    const updated = [...tRoles, { key: `role_${tRoles.length + 1}`, label: 'New Role', description: 'Description' }];
    setTRoles(updated);
    queueChange('workflows', 'travel_approval_roles', updated);
  };
  const removeTravelRole = (index: number) => {
    const updated = tRoles.filter((_: any, i: number) => i !== index);
    setTRoles(updated);
    queueChange('workflows', 'travel_approval_roles', updated);
  };

  return (
    <div className="space-y-6 animate-fade-in">
      <SectionHeading title="Approval & Workflow Defaults" subtitle="Configure global workflow behaviour, default step settings, and form-specific approval chains." />

      <Card className="!p-6">
        <CardHeading icon={<WorkflowIcon />} iconBg="bg-[#F3EADC]" iconColor="text-[#9A7545]" title="Global Workflow Defaults" />
        <p className="text-sm text-gray-500 mb-4">These defaults apply to all new workflows unless overridden per-workflow.</p>
        <div className="space-y-2 mb-4">
          <ToggleSwitch checked={parallel} onChange={(v) => { setParallel(v); queueChange('workflows', 'allow_parallel_approvals', v); }} label="Allow parallel approvals" description="Multiple approvers can act simultaneously" />
          {parallel && (
            <div className="pl-4 border-l-2 border-[#C9B896]">
              <ToggleSwitch checked={allParallel} onChange={(v) => { setAllParallel(v); queueChange('workflows', 'require_all_parallel', v); }} label="Require all parallel approvers" description="All parallel approvers must approve (vs. any one)" />
            </div>
          )}
          <ToggleSwitch checked={skip} onChange={(v) => { setSkip(v); queueChange('workflows', 'allow_skip_steps', v); }} label="Allow skipping steps" description="Approvers can skip to the next step" />
          <ToggleSwitch checked={reassign} onChange={(v) => { setReassign(v); queueChange('workflows', 'allow_reassignment', v); }} label="Allow reassignment" description="Approvers can reassign to another person" />
          <ToggleSwitch checked={withdraw} onChange={(v) => { setWithdraw(v); queueChange('workflows', 'allow_withdraw', v); }} label="Allow requester to withdraw" description="Requester can cancel their submitted request" />
          <ToggleSwitch checked={notifyEach} onChange={(v) => { setNotifyEach(v); queueChange('workflows', 'notify_requester_on_each_step', v); }} label="Notify requester on each step" description="Send notification when each approval step completes" />
          <ToggleSwitch checked={requireAttachments} onChange={(v) => { setRequireAttachments(v); queueChange('workflows', 'require_attachments', v); }} label="Require attachments by default" description="New workflows will require file attachments" />
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 pt-4 border-t border-gray-100">
          <div className="space-y-1">
            <label className="text-sm font-medium text-gray-700">Expiration (days)</label>
            <input type="number" defaultValue={expirationDays} onChange={(e) => queueChange('workflows', 'expiration_days', Number(e.target.value))} className={inputCls} />
          </div>
          <div className="space-y-1">
            <label className="text-sm font-medium text-gray-700">On Expiration</label>
            <select defaultValue={onExpiration} onChange={(e) => queueChange('workflows', 'on_expiration', e.target.value)} className={selectCls}>
              <option value="escalate">Escalate to Manager</option>
              <option value="auto_reject">Auto-Reject</option>
              <option value="auto_approve">Auto-Approve</option>
              <option value="notify">Notify Only</option>
            </select>
          </div>
          <div className="space-y-1">
            <label className="text-sm font-medium text-gray-700">Default Escalation (hours)</label>
            <input type="number" defaultValue={escalationHours} onChange={(e) => queueChange('workflows', 'default_escalation_hours', Number(e.target.value))} className={inputCls} />
          </div>
        </div>
      </Card>

      <Card className="!p-6">
        <CardHeading icon={<svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" /></svg>} iconBg="bg-gray-100" iconColor="text-gray-600" title="Default Step Settings" />
        <p className="text-sm text-gray-500 mb-4">Defaults for each new approval step added to a workflow.</p>
        <div className="space-y-2">
          <ToggleSwitch checked={reqComment} onChange={(v) => { setReqComment(v); queueChange('workflows', 'default_require_comment', v); }} label="Require comment on approval/rejection" />
        </div>
      </Card>

      <Card className="!p-6">
        <CardHeading icon={<RatesIcon />} iconBg="bg-amber-100" iconColor="text-amber-600" title="CAPEX Approval Chain" />
        <p className="text-sm text-gray-500 mb-4">Define the fixed approval roles for CAPEX requests. Order determines approval sequence.</p>
        <div className="space-y-2">
          {cRoles.map((role: any, index: number) => (
            <div key={index} className="flex items-center gap-3 p-3 bg-gray-50 rounded-lg border border-gray-100">
              <span className="w-6 h-6 rounded-full bg-amber-100 text-amber-700 flex items-center justify-center text-xs font-bold flex-shrink-0">{index + 1}</span>
              <input type="text" value={role.label} onChange={(e) => updateCapexRole(index, 'label', e.target.value)} className="flex-1 px-3 py-1.5 text-sm rounded-lg border border-gray-300 focus:ring-2 focus:ring-brand-500" />
              <input type="text" value={role.description} onChange={(e) => updateCapexRole(index, 'description', e.target.value)} className="w-40 px-3 py-1.5 text-sm rounded-lg border border-gray-300 focus:ring-2 focus:ring-brand-500" placeholder="Description" />
              <button onClick={() => removeCapexRole(index)} className="p-1.5 text-red-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors" title="Remove">
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M6 18L18 6M6 6l12 12" /></svg>
              </button>
            </div>
          ))}
          <button onClick={addCapexRole} className="w-full border-2 border-dashed border-gray-300 py-2.5 rounded-xl text-sm text-gray-500 hover:text-gray-700 hover:bg-gray-50 hover:border-gray-400 transition-all">
            + Add Approval Role
          </button>
        </div>
      </Card>

      <Card className="!p-6">
        <CardHeading icon={<TravelIcon />} iconBg="bg-teal-100" iconColor="text-teal-600" title="Travel Authorization Approval Chain" />
        <p className="text-sm text-gray-500 mb-4">Define the fixed approval roles for Travel Authorization requests.</p>
        <div className="space-y-2">
          {tRoles.map((role: any, index: number) => (
            <div key={index} className="flex items-center gap-3 p-3 bg-gray-50 rounded-lg border border-gray-100">
              <span className="w-6 h-6 rounded-full bg-teal-100 text-teal-700 flex items-center justify-center text-xs font-bold flex-shrink-0">{index + 1}</span>
              <input type="text" value={role.label} onChange={(e) => updateTravelRole(index, 'label', e.target.value)} className="flex-1 px-3 py-1.5 text-sm rounded-lg border border-gray-300 focus:ring-2 focus:ring-brand-500" />
              <input type="text" value={role.description} onChange={(e) => updateTravelRole(index, 'description', e.target.value)} className="w-40 px-3 py-1.5 text-sm rounded-lg border border-gray-300 focus:ring-2 focus:ring-brand-500" placeholder="Description" />
              <button onClick={() => removeTravelRole(index)} className="p-1.5 text-red-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors" title="Remove">
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M6 18L18 6M6 6l12 12" /></svg>
              </button>
            </div>
          ))}
          <button onClick={addTravelRole} className="w-full border-2 border-dashed border-gray-300 py-2.5 rounded-xl text-sm text-gray-500 hover:text-gray-700 hover:bg-gray-50 hover:border-gray-400 transition-all">
            + Add Approval Role
          </button>
        </div>
      </Card>
    </div>
  );
}
