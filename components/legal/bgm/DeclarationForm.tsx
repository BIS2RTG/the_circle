import { FieldDef, DeclarationDef, RepeatableDef } from '@/lib/bgmDeclarations';
import { Plus, Trash2 } from 'lucide-react';

/**
 * Renders a governance declaration's form from its schema (lib/bgmDeclarations).
 * Fully controlled: `value` is the form_data object, `onChange` receives the next
 * form_data. Shared by the public director signing page and the staff
 * "complete in person" flow so the two never diverge.
 */
export default function DeclarationForm({
  def, value, onChange, disabled,
}: {
  def: DeclarationDef;
  value: Record<string, any>;
  onChange: (next: Record<string, any>) => void;
  disabled?: boolean;
}) {
  const set = (key: string, v: any) => onChange({ ...value, [key]: v });

  return (
    <div className="space-y-7">
      {def.sections.map((section, si) => (
        <section key={si}>
          {section.title && <h3 className="text-sm font-semibold text-neutral-900">{section.title}</h3>}
          {section.description && <p className="text-sm text-neutral-500 mt-0.5 mb-3">{section.description}</p>}
          {!section.description && section.title && <div className="mb-3" />}

          {section.fields && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-3.5">
              {section.fields.map((f) => (
                <Field key={f.key} f={f} value={value[f.key]} onChange={(v) => set(f.key, v)} disabled={disabled} />
              ))}
            </div>
          )}

          {section.repeatable && (
            <Repeatable r={section.repeatable} value={value} onChange={onChange} disabled={disabled} />
          )}
        </section>
      ))}
    </div>
  );
}

function Field({ f, value, onChange, disabled }: { f: FieldDef; value: any; onChange: (v: any) => void; disabled?: boolean }) {
  const span = f.colSpan === 2 ? 'sm:col-span-2' : '';
  const baseInput =
    'w-full px-3 py-2 rounded-lg border border-gray-200 text-sm text-neutral-800 bg-white focus:outline-none focus:ring-2 focus:ring-brand-500 disabled:bg-neutral-50 disabled:text-neutral-500';

  if (f.type === 'boolean') {
    return (
      <div className={span}>
        <div className="flex items-start justify-between gap-3 rounded-lg border border-gray-200 px-3 py-2.5">
          <label className="text-sm text-neutral-700">{f.label}{f.required && <span className="text-rose-500"> *</span>}</label>
          <YesNo value={value} onChange={onChange} disabled={disabled} />
        </div>
        {f.help && <p className="mt-1 text-xs text-neutral-400">{f.help}</p>}
      </div>
    );
  }

  if (f.type === 'rating') {
    return (
      <div className={span}>
        <div className="flex items-center justify-between gap-3">
          <label className="text-sm text-neutral-700 flex-1">{f.label}{f.required && <span className="text-rose-500"> *</span>}</label>
          <Rating value={value} onChange={onChange} disabled={disabled} />
        </div>
      </div>
    );
  }

  return (
    <div className={span}>
      <label className="block text-sm font-medium text-neutral-700 mb-1">
        {f.label}{f.required && <span className="text-rose-500"> *</span>}
      </label>
      {f.type === 'textarea' ? (
        <textarea value={value ?? ''} onChange={(e) => onChange(e.target.value)} placeholder={f.placeholder} disabled={disabled}
          rows={2} className={`${baseInput} resize-y`} />
      ) : f.type === 'select' ? (
        <select value={value ?? ''} onChange={(e) => onChange(e.target.value)} disabled={disabled} className={baseInput}>
          <option value="">Select…</option>
          {(f.options || []).map((o) => <option key={o} value={o}>{o}</option>)}
        </select>
      ) : (
        <input
          type={f.type === 'tel' ? 'tel' : f.type === 'email' ? 'email' : f.type === 'date' ? 'date' : f.type === 'number' ? 'number' : 'text'}
          value={value ?? ''} onChange={(e) => onChange(e.target.value)} placeholder={f.placeholder} disabled={disabled}
          className={baseInput} />
      )}
      {f.help && <p className="mt-1 text-xs text-neutral-400">{f.help}</p>}
    </div>
  );
}

function YesNo({ value, onChange, disabled }: { value: any; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <div className="inline-flex rounded-lg border border-gray-200 overflow-hidden shrink-0">
      {[['Yes', true], ['No', false]].map(([label, v]) => (
        <button key={String(v)} type="button" disabled={disabled} onClick={() => onChange(v as boolean)}
          className={`px-3 py-1 text-sm font-medium transition-colors ${value === v ? (v ? 'bg-emerald-500 text-white' : 'bg-rose-500 text-white') : 'bg-white text-neutral-500 hover:bg-neutral-50'}`}>
          {label as string}
        </button>
      ))}
    </div>
  );
}

function Rating({ value, onChange, disabled }: { value: any; onChange: (v: number) => void; disabled?: boolean }) {
  return (
    <div className="inline-flex rounded-lg border border-gray-200 overflow-hidden shrink-0">
      {[1, 2, 3, 4, 5].map((n) => (
        <button key={n} type="button" disabled={disabled} onClick={() => onChange(n)} title={`${n}`}
          className={`w-9 py-1 text-sm font-semibold border-l first:border-l-0 border-gray-200 transition-colors ${value === n ? 'bg-brand-500 text-white' : 'bg-white text-neutral-500 hover:bg-neutral-50'}`}>
          {n}
        </button>
      ))}
    </div>
  );
}

function Repeatable({ r, value, onChange, disabled }: { r: RepeatableDef; value: Record<string, any>; onChange: (next: Record<string, any>) => void; disabled?: boolean }) {
  const nilKey = `${r.key}_nil`;
  const rows: any[] = Array.isArray(value[r.key]) ? value[r.key] : [];
  const isNil = !!value[nilKey];

  const setRows = (next: any[]) => onChange({ ...value, [r.key]: next, [nilKey]: false });
  const addRow = () => setRows([...rows, {}]);
  const removeRow = (i: number) => setRows(rows.filter((_, idx) => idx !== i));
  const setCell = (i: number, key: string, v: any) => setRows(rows.map((row, idx) => (idx === i ? { ...row, [key]: v } : row)));
  const toggleNil = () => onChange({ ...value, [nilKey]: !isNil, [r.key]: [] });

  return (
    <div>
      {!isNil && (
        <div className="space-y-3">
          {rows.length === 0 && (
            <p className="text-sm text-neutral-400 italic py-1">No {r.itemNoun}s added yet.</p>
          )}
          {rows.map((row, i) => (
            <div key={i} className="rounded-xl border border-gray-200 bg-neutral-50/60 p-3">
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-semibold uppercase tracking-wider text-neutral-400 capitalize">{r.itemNoun} {i + 1}</span>
                {!disabled && (
                  <button type="button" onClick={() => removeRow(i)} className="text-neutral-400 hover:text-rose-600" title="Remove">
                    <Trash2 className="w-4 h-4" />
                  </button>
                )}
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-3">
                {r.columns.map((c) => (
                  <Field key={c.key} f={c} value={row[c.key]} onChange={(v) => setCell(i, c.key, v)} disabled={disabled} />
                ))}
              </div>
            </div>
          ))}
          {!disabled && (
            <button type="button" onClick={addRow}
              className="inline-flex items-center gap-1.5 text-sm font-medium text-brand-600 hover:text-brand-700">
              <Plus className="w-4 h-4" /> {r.addLabel}
            </button>
          )}
        </div>
      )}

      {!disabled && (
        <label className="mt-3 flex items-center gap-2.5 cursor-pointer">
          <input type="checkbox" checked={isNil} onChange={toggleNil}
            className="w-4 h-4 rounded border-gray-300 text-brand-600 focus:ring-brand-500" />
          <span className="text-sm text-neutral-600">{r.nilLabel}</span>
        </label>
      )}
      {disabled && isNil && (
        <p className="text-sm text-neutral-500 italic">{r.nilLabel}.</p>
      )}
    </div>
  );
}
