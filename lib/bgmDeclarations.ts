/**
 * BGM-03 — Electronic Governance Declarations: shared, CLIENT-SAFE schema.
 *
 * Defines the five digital governance forms that replace the paper versions,
 * their field layouts, the attestation each director signs, and how a submitted
 * declaration projects into the governance registers and Director profiles.
 *
 * NO server-only imports here — this module is used by API routes, the admin
 * pages and the public (login-free) director signing page alike.
 */

export const DECLARATION_TYPES = [
  'director_information',
  'declaration_of_interest',
  'related_party',
  'annual_governance',
  'board_evaluation',
] as const;
export type DeclarationType = (typeof DECLARATION_TYPES)[number];

export const DECLARATION_STATUSES = ['draft', 'issued', 'submitted', 'cancelled'] as const;
export type DeclarationStatus = (typeof DECLARATION_STATUSES)[number];

export const DECLARATION_STATUS_LABELS: Record<DeclarationStatus, string> = {
  draft: 'Draft',
  issued: 'Awaiting director',
  submitted: 'Submitted',
  cancelled: 'Cancelled',
};

export const DECLARATION_STATUS_STYLES: Record<DeclarationStatus, { bg: string; text: string; dot: string }> = {
  draft: { bg: 'bg-neutral-100', text: 'text-neutral-600', dot: 'bg-neutral-400' },
  issued: { bg: 'bg-amber-50', text: 'text-amber-700', dot: 'bg-amber-500' },
  submitted: { bg: 'bg-emerald-50', text: 'text-emerald-700', dot: 'bg-emerald-500' },
  cancelled: { bg: 'bg-rose-50', text: 'text-rose-700', dot: 'bg-rose-500' },
};

// ---- Field schema ------------------------------------------------------------

export type FieldType =
  | 'text' | 'textarea' | 'date' | 'email' | 'tel' | 'select' | 'boolean' | 'rating' | 'number';

export interface FieldDef {
  key: string;
  label: string;
  type: FieldType;
  required?: boolean;
  placeholder?: string;
  help?: string;
  options?: string[];
  /** grid columns (1 = half width on sm+, 2 = full width). Default 1. */
  colSpan?: 1 | 2;
}

/** A repeatable entry table (e.g. interests, related parties, directorships). */
export interface RepeatableDef {
  key: string;
  itemNoun: string;      // singular, e.g. "interest"
  addLabel: string;      // e.g. "Add interest"
  columns: FieldDef[];
  /** Attestation shown when the director declares nothing to disclose. */
  nilLabel: string;      // e.g. "I have no interests to declare"
}

export interface SectionDef {
  title?: string;
  description?: string;
  fields?: FieldDef[];
  repeatable?: RepeatableDef;
}

export interface DeclarationDef {
  type: DeclarationType;
  title: string;
  shortLabel: string;
  description: string;         // admin-facing summary
  instructions: string;        // director-facing intro on the signing page
  /** Annual attestations are period-scoped (governance year). */
  isAnnual: boolean;
  /** Which governance register this declaration feeds, if any. */
  registerKey?: 'interests' | 'related_party';
  sections: SectionDef[];
  attestation: string;         // statement above the signature block
}

// ---- Reusable column sets ----------------------------------------------------

const interestColumns: FieldDef[] = [
  { key: 'entity', label: 'Company / entity / body', type: 'text', required: true, colSpan: 2 },
  { key: 'nature', label: 'Nature of interest', type: 'text', required: true, help: 'e.g. Directorship, Shareholding, Partnership, Trusteeship, Employment' },
  { key: 'position', label: 'Position / capacity held', type: 'text' },
  { key: 'since', label: 'Held since', type: 'date' },
  { key: 'notes', label: 'Notes', type: 'textarea', colSpan: 2 },
];

const relatedPartyColumns: FieldDef[] = [
  { key: 'party', label: 'Related party', type: 'text', required: true, colSpan: 2 },
  { key: 'relationship', label: 'Relationship to you', type: 'text', required: true, help: 'e.g. Spouse, Family member, Entity you control' },
  { key: 'transaction', label: 'Nature of transaction / dealing with RTG', type: 'textarea', required: true, colSpan: 2 },
  { key: 'value', label: 'Approx. value (ZAR)', type: 'text' },
  { key: 'ongoing', label: 'Ongoing?', type: 'select', options: ['One-off', 'Ongoing'] },
];

const directorshipColumns: FieldDef[] = [
  { key: 'company', label: 'Company / organisation', type: 'text', required: true, colSpan: 2 },
  { key: 'position', label: 'Position', type: 'text', required: true },
  { key: 'listed', label: 'Listed?', type: 'select', options: ['Unlisted', 'Listed'] },
  { key: 'appointed', label: 'Appointed', type: 'date' },
];

// ---- Board-evaluation rating questions --------------------------------------

const boardEvalRatings = (prefix: string, items: [string, string][]): FieldDef[] =>
  items.map(([key, label]) => ({ key: `${prefix}_${key}`, label, type: 'rating' as const, required: true }));

// ---- The five declarations ---------------------------------------------------

export const DECLARATIONS: Record<DeclarationType, DeclarationDef> = {
  director_information: {
    type: 'director_information',
    title: 'Director Information Form',
    shortLabel: 'Director Information',
    description: 'Biographical, contact and appointment particulars kept on the statutory register of directors.',
    instructions: 'Please confirm and complete your particulars as a director of Rainbow Tourism Group. These details are held on the statutory register of directors and used for all board correspondence.',
    isAnnual: false,
    sections: [
      {
        title: 'Personal particulars',
        fields: [
          { key: 'full_name', label: 'Full legal name', type: 'text', required: true, colSpan: 2 },
          { key: 'preferred_name', label: 'Preferred name', type: 'text' },
          { key: 'salutation', label: 'Salutation', type: 'select', options: ['Mr', 'Mrs', 'Ms', 'Dr', 'Prof', 'Adv', 'Eng', 'Hon'] },
          { key: 'nationality', label: 'Nationality', type: 'text' },
          { key: 'id_number', label: 'National ID / passport number', type: 'text' },
          { key: 'date_of_birth', label: 'Date of birth', type: 'date' },
          { key: 'occupation', label: 'Principal occupation', type: 'text', colSpan: 2 },
        ],
      },
      {
        title: 'Contact details',
        fields: [
          { key: 'email', label: 'Email address', type: 'email', required: true },
          { key: 'phone', label: 'Mobile number', type: 'tel', required: true },
          { key: 'residential_address', label: 'Residential address', type: 'textarea', colSpan: 2 },
          { key: 'postal_address', label: 'Postal address', type: 'textarea', colSpan: 2 },
        ],
      },
      {
        title: 'Appointment',
        fields: [
          { key: 'appointed_date', label: 'Date first appointed', type: 'date' },
          { key: 'is_independent', label: 'Independent non-executive director?', type: 'boolean' },
        ],
      },
      {
        title: 'Other directorships',
        description: 'List any other directorships or trusteeships you currently hold.',
        repeatable: {
          key: 'other_directorships',
          itemNoun: 'directorship',
          addLabel: 'Add directorship',
          columns: directorshipColumns,
          nilLabel: 'I hold no other directorships or trusteeships',
        },
      },
    ],
    attestation: 'I confirm that the information provided above is true, complete and correct to the best of my knowledge, and I undertake to notify the Company Secretary of any material change.',
  },

  declaration_of_interest: {
    type: 'declaration_of_interest',
    title: 'Declaration of Interest',
    shortLabel: 'Declaration of Interest',
    description: 'Declarable personal, financial and business interests recorded in the register of directors’ interests.',
    instructions: 'In accordance with the Companies Act and the Board Charter, please declare all interests that could, or could reasonably be perceived to, conflict with your duties to Rainbow Tourism Group.',
    isAnnual: true,
    registerKey: 'interests',
    sections: [
      {
        description: 'Declare each interest below. If you have none, tick the nil-declaration box.',
        repeatable: {
          key: 'interests',
          itemNoun: 'interest',
          addLabel: 'Add interest',
          columns: interestColumns,
          nilLabel: 'I have no interests to declare',
        },
      },
      {
        title: 'General disclosure',
        fields: [
          { key: 'general_notes', label: 'Any other matter you wish to disclose', type: 'textarea', colSpan: 2 },
        ],
      },
    ],
    attestation: 'I declare that the above represents a full and accurate account of my interests. I undertake to declare any further interest as it arises and to recuse myself from any deliberation in which I have a conflict.',
  },

  related_party: {
    type: 'related_party',
    title: 'Related Party Disclosure',
    shortLabel: 'Related Party Disclosure',
    description: 'Disclosure of related parties and their dealings with the Group, recorded in the related-party register.',
    instructions: 'Please disclose any related parties (family members, or entities you or a family member control or influence) that transact or have arrangements with Rainbow Tourism Group.',
    isAnnual: true,
    registerKey: 'related_party',
    sections: [
      {
        description: 'Disclose each related party and dealing below. If none apply, tick the nil-declaration box.',
        repeatable: {
          key: 'related_parties',
          itemNoun: 'related party',
          addLabel: 'Add related party',
          columns: relatedPartyColumns,
          nilLabel: 'I have no related-party dealings to disclose',
        },
      },
    ],
    attestation: 'I confirm that the related-party information disclosed above is complete and accurate, and I undertake to update it should circumstances change.',
  },

  annual_governance: {
    type: 'annual_governance',
    title: 'Annual Governance Declaration',
    shortLabel: 'Annual Governance Declaration',
    description: 'Annual fit-and-proper, independence and code-of-conduct attestation by each director.',
    instructions: 'This annual declaration confirms your continued eligibility to serve and your commitment to the Group’s governance codes. Please answer each item.',
    isAnnual: true,
    sections: [
      {
        title: 'Fit and proper',
        fields: [
          { key: 'fit_and_proper', label: 'I remain fit and proper to hold office and am not disqualified from acting as a director.', type: 'boolean', required: true, colSpan: 2 },
          { key: 'no_insolvency', label: 'I have not been declared insolvent nor been party to any business rescue or liquidation in the past year.', type: 'boolean', required: true, colSpan: 2 },
          { key: 'no_convictions', label: 'I have no undisclosed criminal convictions or regulatory sanctions.', type: 'boolean', required: true, colSpan: 2 },
        ],
      },
      {
        title: 'Independence & conduct',
        fields: [
          { key: 'independence_maintained', label: 'Where classified as independent, I confirm my independence is maintained.', type: 'boolean', colSpan: 2 },
          { key: 'code_of_conduct', label: 'I have read, understood and complied with the Board Charter and Code of Conduct.', type: 'boolean', required: true, colSpan: 2 },
          { key: 'interests_current', label: 'My register of interests is complete and up to date.', type: 'boolean', required: true, colSpan: 2 },
        ],
      },
      {
        title: 'Exceptions',
        fields: [
          { key: 'exceptions', label: 'Detail any exception to the confirmations above', type: 'textarea', colSpan: 2, help: 'Leave blank if there are no exceptions.' },
        ],
      },
    ],
    attestation: 'I make this annual declaration knowing that the Board and its regulators rely upon it, and confirm that my responses are true and complete.',
  },

  board_evaluation: {
    type: 'board_evaluation',
    title: 'Board Evaluation Questionnaire',
    shortLabel: 'Board Evaluation',
    description: 'Confidential board and committee effectiveness self-assessment (1 = strongly disagree, 5 = strongly agree).',
    instructions: 'This confidential questionnaire assesses the effectiveness of the Board and its committees. Rate each statement from 1 (strongly disagree) to 5 (strongly agree). Your individual responses are seen only by the Company Secretary and are reported in aggregate.',
    isAnnual: true,
    sections: [
      {
        title: 'Board composition & dynamics',
        fields: boardEvalRatings('composition', [
          ['balance', 'The Board has an appropriate balance of skills, experience and diversity.'],
          ['independence', 'The Board exercises objective, independent judgement.'],
          ['debate', 'Meetings allow for open, constructive challenge and debate.'],
        ]),
      },
      {
        title: 'Effectiveness & oversight',
        fields: boardEvalRatings('effectiveness', [
          ['strategy', 'The Board devotes sufficient time to strategy.'],
          ['risk', 'Risk and internal control are effectively overseen.'],
          ['information', 'Board papers are timely, clear and of sufficient quality.'],
          ['committees', 'The committees discharge their mandates effectively.'],
        ]),
      },
      {
        title: 'Chair & governance',
        fields: boardEvalRatings('chair', [
          ['leadership', 'The Chair provides effective leadership of the Board.'],
          ['culture', 'The Board sets an appropriate tone, ethics and culture.'],
        ]),
      },
      {
        title: 'Open feedback',
        fields: [
          { key: 'working_well', label: 'What is working well?', type: 'textarea', colSpan: 2 },
          { key: 'improve', label: 'What could be improved?', type: 'textarea', colSpan: 2 },
        ],
      },
    ],
    attestation: 'I confirm that this evaluation reflects my honest assessment of the Board’s effectiveness.',
  },
};

export const DECLARATION_LIST: DeclarationDef[] = DECLARATION_TYPES.map((t) => DECLARATIONS[t]);

export function getDeclarationDef(type: string): DeclarationDef | null {
  return (DECLARATIONS as Record<string, DeclarationDef>)[type] || null;
}

export function declarationLabel(type: string): string {
  return getDeclarationDef(type)?.shortLabel || type;
}

// ---- Auto-populate: Director Information → directors row ----------------------

/**
 * Map submitted director_information form_data onto editable columns of the
 * `directors` table. Only returns keys that carry a value so a blank field never
 * wipes existing data.
 */
export function directorProfilePatchFromInfo(formData: Record<string, any>): Record<string, any> {
  const patch: Record<string, any> = {};
  const str = (v: any) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
  if (str(formData.email)) patch.email = str(formData.email);
  if (str(formData.phone)) patch.phone = str(formData.phone);
  if (str(formData.salutation)) patch.salutation = str(formData.salutation);
  if (str(formData.appointed_date)) patch.appointed_date = str(formData.appointed_date);
  if (typeof formData.is_independent === 'boolean') patch.is_independent = formData.is_independent;
  return patch;
}

// ---- Register projection -----------------------------------------------------

export interface RegisterEntry {
  director_id: string;
  director_name: string;
  declaration_id: string;
  submitted_at: string | null;
  period_year: number | null;
  fields: Record<string, any>;
}

/** Which repeatable key holds a register's rows for a given register. */
export const REGISTER_ROW_KEY: Record<'interests' | 'related_party', string> = {
  interests: 'interests',
  related_party: 'related_parties',
};

/** Column definitions to render for each register table. */
export const REGISTER_COLUMNS: Record<'interests' | 'related_party', FieldDef[]> = {
  interests: interestColumns,
  related_party: relatedPartyColumns,
};
