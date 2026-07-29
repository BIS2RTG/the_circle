import { createClient, SupabaseClient } from '@supabase/supabase-js';

const hrimsUrl = process.env.HRIMS_SUPABASE_URL;
const hrimsServiceRoleKey = process.env.HRIMS_SUPABASE_SERVICE_ROLE_KEY;

let hrimsClient: SupabaseClient;

if (hrimsUrl && hrimsServiceRoleKey) {
  hrimsClient = createClient(hrimsUrl, hrimsServiceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });
} else {
  console.warn('Missing HRIMS_SUPABASE_URL or HRIMS_SUPABASE_SERVICE_ROLE_KEY environment variables');
  hrimsClient = null as unknown as SupabaseClient;
}

export { hrimsClient };

// ============================================================================
// HRIMS Data Types
// ============================================================================

export interface HrimsOrganogramPosition {
  id: string;
  organization_id: string;
  business_unit_id: string;
  position_title: string;
  position_code: string | null;
  grade: string | null;
  level: number;
  description: string | null;
  status: 'vacant' | 'filled' | 'frozen';
  parent_position_id: string | null;
  employee_id: string | null;
  department_id: string | null;
  sort_order: number;
  is_active: boolean;
  // Joined fields
  employee?: HrimsEmployee | null;
  department?: HrimsDepartment | null;
  business_unit?: HrimsBusinessUnit | null;
  parent_position?: { id: string; position_title: string } | null;
  children?: HrimsOrganogramPosition[];
}

export interface HrimsEmployee {
  id: string;
  first_name: string;
  last_name: string;
  email: string;
  phone: string | null;
  job_title: string | null;
  employee_number: string;
  employment_status: string;
  manager_id: string | null;
  department_id: string | null;
  business_unit_id: string;
  current_position_id: string | null;
}

export interface HrimsDepartment {
  id: string;
  name: string;
  code: string;
  department_head_id: string | null;
  business_unit_id: string;
}

export interface HrimsBusinessUnit {
  id: string;
  name: string;
  code: string;
  type: string;
  is_active: boolean;
}

// ============================================================================
// HRIMS Query Functions (server-side only)
// ============================================================================

/**
 * Fetch the full organogram tree for a business unit
 */
export async function fetchOrganogramPositions(
  businessUnitId?: string
): Promise<HrimsOrganogramPosition[]> {
  if (!hrimsClient) throw new Error('HRIMS client not configured');

  let query = hrimsClient
    .from('organogram_positions')
    .select(`
      id, organization_id, business_unit_id, position_title, position_code,
      grade, level, description, status, parent_position_id, employee_id,
      department_id, sort_order, is_active,
      employees:employee_id (id, first_name, last_name, email, phone, job_title, employee_number, employment_status, manager_id, department_id, business_unit_id, current_position_id),
      departments:department_id (id, name, code, department_head_id, business_unit_id),
      business_units:business_unit_id (id, name, code, type, is_active)
    `)
    .eq('is_active', true)
    .order('level', { ascending: true })
    .order('sort_order', { ascending: true });

  if (businessUnitId) {
    query = query.eq('business_unit_id', businessUnitId);
  }

  const { data, error } = await query;

  if (error) {
    console.error('Failed to fetch organogram positions:', error);
    throw new Error(`HRIMS query failed: ${error.message}`);
  }

  return ((data || []) as any[]).map(row => ({
    ...row,
    employee: row.employees || null,
    department: row.departments || null,
    business_unit: row.business_units || null,
  })) as HrimsOrganogramPosition[];
}

/**
 * Build a tree structure from flat organogram positions
 */
export function buildOrganogramTree(
  positions: HrimsOrganogramPosition[]
): HrimsOrganogramPosition[] {
  const positionMap = new Map<string, HrimsOrganogramPosition>();
  const roots: HrimsOrganogramPosition[] = [];

  // Index all positions
  for (const pos of positions) {
    positionMap.set(pos.id, { ...pos, children: [] });
  }

  // Build tree
  for (const pos of positionMap.values()) {
    if (pos.parent_position_id && positionMap.has(pos.parent_position_id)) {
      positionMap.get(pos.parent_position_id)!.children!.push(pos);
    } else {
      roots.push(pos);
    }
  }

  return roots;
}

/**
 * Fetch all active employees from HRIMS
 */
export async function fetchHrimsEmployees(
  businessUnitId?: string
): Promise<HrimsEmployee[]> {
  if (!hrimsClient) throw new Error('HRIMS client not configured');

  let query = hrimsClient
    .from('employees')
    .select('id, first_name, last_name, email, phone, job_title, employee_number, employment_status, manager_id, department_id, business_unit_id, current_position_id')
    .eq('employment_status', 'active')
    .order('last_name', { ascending: true });

  if (businessUnitId) {
    query = query.eq('business_unit_id', businessUnitId);
  }

  const { data, error } = await query;

  if (error) {
    console.error('Failed to fetch HRIMS employees:', error);
    throw new Error(`HRIMS query failed: ${error.message}`);
  }

  return (data || []) as HrimsEmployee[];
}

/**
 * Fetch all business units from HRIMS
 */
export async function fetchHrimsBusinessUnits(): Promise<HrimsBusinessUnit[]> {
  if (!hrimsClient) throw new Error('HRIMS client not configured');

  const { data, error } = await hrimsClient
    .from('business_units')
    .select('id, name, code, type, is_active')
    .eq('is_active', true)
    .order('name', { ascending: true });

  if (error) {
    console.error('Failed to fetch HRIMS business units:', error);
    throw new Error(`HRIMS query failed: ${error.message}`);
  }

  return (data || []) as HrimsBusinessUnit[];
}

/**
 * Fetch departments from HRIMS
 */
export async function fetchHrimsDepartments(
  businessUnitId?: string
): Promise<HrimsDepartment[]> {
  if (!hrimsClient) throw new Error('HRIMS client not configured');

  let query = hrimsClient
    .from('departments')
    .select('id, name, code, department_head_id, business_unit_id')
    .order('name', { ascending: true });

  if (businessUnitId) {
    query = query.eq('business_unit_id', businessUnitId);
  }

  const { data, error } = await query;

  if (error) {
    console.error('Failed to fetch HRIMS departments:', error);
    throw new Error(`HRIMS query failed: ${error.message}`);
  }

  return (data || []) as HrimsDepartment[];
}

/** Fetch a single department by id (null when missing or HRIMS unconfigured). */
export async function fetchHrimsDepartmentById(id: string): Promise<HrimsDepartment | null> {
  if (!hrimsClient || !id) return null;
  const { data } = await hrimsClient
    .from('departments')
    .select('id, name, code, department_head_id, business_unit_id')
    .eq('id', id)
    .maybeSingle();
  return (data as HrimsDepartment) || null;
}

/** Fetch a single business unit by id (null when missing or HRIMS unconfigured). */
export async function fetchHrimsBusinessUnitById(id: string): Promise<HrimsBusinessUnit | null> {
  if (!hrimsClient || !id) return null;
  const { data } = await hrimsClient
    .from('business_units')
    .select('id, name, code, type, is_active')
    .eq('id', id)
    .maybeSingle();
  return (data as HrimsBusinessUnit) || null;
}

/**
 * Resolve the approval chain from the organogram for a given employee.
 * Walks up the organogram tree from the employee's position to the root,
 * returning the chain of filled positions (with employees) above them.
 */
export async function resolveApprovalChainFromOrganogram(
  employeeEmail: string
): Promise<{ position: HrimsOrganogramPosition; employee: HrimsEmployee }[]> {
  if (!hrimsClient) throw new Error('HRIMS client not configured');

  // 1. Find the employee by email (case-insensitive)
  const { data: employee, error: empError } = await hrimsClient
    .from('employees')
    .select('id, first_name, last_name, email, job_title, current_position_id, business_unit_id')
    .ilike('email', employeeEmail)
    .eq('employment_status', 'active')
    .single();

  if (empError || !employee) {
    console.error('Employee not found in HRIMS:', employeeEmail, empError);
    return [];
  }

  // 2. Find their position in the organogram
  let currentPositionId = employee.current_position_id;

  if (!currentPositionId) {
    // Fallback: find position by employee_id
    const { data: pos } = await hrimsClient
      .from('organogram_positions')
      .select('id, parent_position_id')
      .eq('employee_id', employee.id)
      .eq('is_active', true)
      .single();

    if (!pos) return [];
    currentPositionId = pos.id;
  }

  // 3. Walk up the tree collecting filled positions
  const chain: { position: HrimsOrganogramPosition; employee: HrimsEmployee }[] = [];
  let visitedIds = new Set<string>();

  // Get the current position to find its parent
  const { data: startPos } = await hrimsClient
    .from('organogram_positions')
    .select('id, parent_position_id')
    .eq('id', currentPositionId)
    .single();

  if (!startPos?.parent_position_id) return [];

  let nextParentId: string | null = startPos.parent_position_id;

  while (nextParentId && !visitedIds.has(nextParentId)) {
    visitedIds.add(nextParentId);

    const { data: parentPos } = await hrimsClient
      .from('organogram_positions')
      .select(`
        id, organization_id, business_unit_id, position_title, position_code,
        grade, level, description, status, parent_position_id, employee_id,
        department_id, sort_order, is_active
      `)
      .eq('id', nextParentId)
      .eq('is_active', true)
      .single();

    if (!parentPos) break;

    // Find the employee assigned to this position via current_position_id (primary)
    // or via the position's employee_id field (fallback)
    let emp: HrimsEmployee | null = null;

    // Primary: find employee whose current_position_id matches this position
    const { data: empByPos } = await hrimsClient
      .from('employees')
      .select('id, first_name, last_name, email, phone, job_title, employee_number, employment_status, manager_id, department_id, business_unit_id, current_position_id')
      .eq('current_position_id', parentPos.id)
      .eq('employment_status', 'active')
      .limit(1)
      .single();

    if (empByPos) {
      emp = empByPos as HrimsEmployee;
    } else if (parentPos.employee_id) {
      // Fallback: use the employee_id join on the position
      const { data: empById } = await hrimsClient
        .from('employees')
        .select('id, first_name, last_name, email, phone, job_title, employee_number, employment_status, manager_id, department_id, business_unit_id, current_position_id')
        .eq('id', parentPos.employee_id)
        .eq('employment_status', 'active')
        .single();

      if (empById) {
        emp = empById as HrimsEmployee;
      }
    }

    if (emp) {
      chain.push({
        position: {
          ...parentPos,
          employee: emp,
        } as HrimsOrganogramPosition,
        employee: emp,
      });
    }

    nextParentId = parentPos.parent_position_id;
  }

  return chain;
}

/**
 * Fetch an employee by their email address from HRIMS
 * Returns employee details including department_id, business_unit_id, job_title, etc.
 */
export interface HrimsReportsTo {
  name: string;
  email: string | null;
  jobTitle: string | null;
}

export async function fetchHrimsEmployeeByEmail(
  email: string
): Promise<{
  employee: HrimsEmployee;
  department: HrimsDepartment | null;
  businessUnit: HrimsBusinessUnit | null;
  position: HrimsOrganogramPosition | null;
  /** Immediate manager from the organogram (null for top positions like the CEO). */
  reportsTo: HrimsReportsTo | null;
} | null> {
  if (!hrimsClient) throw new Error('HRIMS client not configured');

  // Find the employee by email (case-insensitive)
  const { data: employee, error: empError } = await hrimsClient
    .from('employees')
    .select(`
      id, first_name, last_name, email, phone, job_title, employee_number,
      employment_status, manager_id, department_id, business_unit_id, current_position_id
    `)
    .ilike('email', email)
    .eq('employment_status', 'active')
    .single();

  if (empError || !employee) {
    console.log('Employee not found in HRIMS:', email);
    return null;
  }

  // Fetch department if available
  let department: HrimsDepartment | null = null;
  if (employee.department_id) {
    const { data: deptData } = await hrimsClient
      .from('departments')
      .select('id, name, code, department_head_id, business_unit_id')
      .eq('id', employee.department_id)
      .single();
    department = deptData as HrimsDepartment | null;
  }

  // Fetch business unit if available
  let businessUnit: HrimsBusinessUnit | null = null;
  if (employee.business_unit_id) {
    const { data: buData } = await hrimsClient
      .from('business_units')
      .select('id, name, code, type, is_active')
      .eq('id', employee.business_unit_id)
      .single();
    businessUnit = buData as HrimsBusinessUnit | null;
  }

  // Fetch position if available
  let position: HrimsOrganogramPosition | null = null;
  if (employee.current_position_id) {
    const { data: posData } = await hrimsClient
      .from('organogram_positions')
      .select(`
        id, organization_id, business_unit_id, position_title, position_code,
        grade, level, description, status, parent_position_id, employee_id,
        department_id, sort_order, is_active
      `)
      .eq('id', employee.current_position_id)
      .single();
    position = posData as HrimsOrganogramPosition | null;
  }

  // Resolve who this employee reports to. Primary: the active occupant of the
  // parent position in the organogram. Fallback: employees.manager_id. Top
  // positions (e.g. the CEO) have neither, so this stays null.
  let reportsTo: HrimsReportsTo | null = null;

  if (position?.parent_position_id) {
    const { data: parentPos } = await hrimsClient
      .from('organogram_positions')
      .select('id, position_title, employee_id')
      .eq('id', position.parent_position_id)
      .eq('is_active', true)
      .single();

    if (parentPos) {
      let mgr: Pick<HrimsEmployee, 'first_name' | 'last_name' | 'email' | 'job_title'> | null = null;

      const { data: mgrByPos } = await hrimsClient
        .from('employees')
        .select('first_name, last_name, email, job_title')
        .eq('current_position_id', parentPos.id)
        .eq('employment_status', 'active')
        .limit(1)
        .single();

      if (mgrByPos) {
        mgr = mgrByPos;
      } else if (parentPos.employee_id) {
        const { data: mgrById } = await hrimsClient
          .from('employees')
          .select('first_name, last_name, email, job_title')
          .eq('id', parentPos.employee_id)
          .eq('employment_status', 'active')
          .single();
        if (mgrById) mgr = mgrById;
      }

      if (mgr) {
        reportsTo = {
          name: `${mgr.first_name} ${mgr.last_name}`.trim(),
          email: mgr.email || null,
          jobTitle: parentPos.position_title || mgr.job_title || null,
        };
      }
    }
  }

  if (!reportsTo && employee.manager_id) {
    const { data: mgr } = await hrimsClient
      .from('employees')
      .select('first_name, last_name, email, job_title')
      .eq('id', employee.manager_id)
      .eq('employment_status', 'active')
      .single();
    if (mgr) {
      reportsTo = {
        name: `${mgr.first_name} ${mgr.last_name}`.trim(),
        email: mgr.email || null,
        jobTitle: mgr.job_title || null,
      };
    }
  }

  return {
    employee: employee as HrimsEmployee,
    department,
    businessUnit,
    position,
    reportsTo,
  };
}

export async function findEmployeeByPositionTitle(
  positionTitle: string,
  businessUnitId?: string
): Promise<{ position: HrimsOrganogramPosition; employee: HrimsEmployee } | null> {
  if (!hrimsClient) throw new Error('HRIMS client not configured');

  // HRIMS position titles sometimes carry stray surrounding whitespace
  // (e.g. "Chief Human Capital Officer " has a trailing space). An exact
  // `ilike` match would miss those, so we fetch candidates with a contains
  // match and then require equality once whitespace/case is normalised. This
  // keeps the match precise — searching "CEO" won't pick up "PA to CEO".
  const trimmed = positionTitle.trim();

  let query = hrimsClient
    .from('organogram_positions')
    .select(`
      id, organization_id, business_unit_id, position_title, position_code,
      grade, level, description, status, parent_position_id, employee_id,
      department_id, sort_order, is_active
    `)
    .ilike('position_title', `%${trimmed}%`)
    .eq('is_active', true);

  if (businessUnitId) {
    query = query.eq('business_unit_id', businessUnitId);
  }

  const { data: candidates, error } = await query.limit(20);

  if (error || !candidates || candidates.length === 0) return null;

  const wanted = trimmed.toLowerCase();
  const data =
    candidates.find(
      (p: any) => (p.position_title || '').trim().toLowerCase() === wanted
    ) || null;

  if (!data) return null;

  // Find the employee assigned to this position via current_position_id (primary)
  // or via the position's employee_id field (fallback)
  let emp: HrimsEmployee | null = null;

  // Primary: find employee whose current_position_id matches this position
  const { data: empByPos } = await hrimsClient
    .from('employees')
    .select('id, first_name, last_name, email, phone, job_title, employee_number, employment_status, manager_id, department_id, business_unit_id, current_position_id')
    .eq('current_position_id', data.id)
    .eq('employment_status', 'active')
    .limit(1)
    .single();

  if (empByPos) {
    emp = empByPos as HrimsEmployee;
  } else if (data.employee_id) {
    // Fallback: use the employee_id on the position
    const { data: empById } = await hrimsClient
      .from('employees')
      .select('id, first_name, last_name, email, phone, job_title, employee_number, employment_status, manager_id, department_id, business_unit_id, current_position_id')
      .eq('id', data.employee_id)
      .eq('employment_status', 'active')
      .single();

    if (empById) {
      emp = empById as HrimsEmployee;
    }
  }

  if (!emp) return null;

  return {
    position: { ...data, employee: emp } as HrimsOrganogramPosition,
    employee: emp,
  };
}

// ============================================================================
// Executive / CHCO position resolution (HRIMS side only).
// The app_user mapping + delegation checks live in lib/executives.ts (server).
// ============================================================================

/** Resolve the active employee occupying a position (current_position_id first, then employee_id). */
export async function employeeForPosition(
  positionId: string,
  fallbackEmployeeId: string | null
): Promise<HrimsEmployee | null> {
  const { data: byPos } = await hrimsClient
    .from('employees')
    .select('id, first_name, last_name, email, phone, job_title, employee_number, employment_status, manager_id, department_id, business_unit_id, current_position_id')
    .eq('current_position_id', positionId)
    .eq('employment_status', 'active')
    .limit(1)
    .maybeSingle();
  if (byPos) return byPos as HrimsEmployee;

  if (fallbackEmployeeId) {
    const { data: byId } = await hrimsClient
      .from('employees')
      .select('id, first_name, last_name, email, phone, job_title, employee_number, employment_status, manager_id, department_id, business_unit_id, current_position_id')
      .eq('id', fallbackEmployeeId)
      .eq('employment_status', 'active')
      .maybeSingle();
    if (byId) return byId as HrimsEmployee;
  }
  return null;
}

/** Find the CEO's organogram position, trying the common title variants. */
export async function findCeoPosition(): Promise<HrimsOrganogramPosition | null> {
  if (!hrimsClient) return null;
  const titles = ['CEO', 'Chief Executive Officer', 'Group CEO', 'Managing Director & CEO'];
  for (const title of titles) {
    const { data } = await hrimsClient
      .from('organogram_positions')
      .select('id, organization_id, business_unit_id, position_title, position_code, grade, level, description, status, parent_position_id, employee_id, department_id, sort_order, is_active')
      .ilike('position_title', title)
      .eq('is_active', true)
      .limit(1)
      .maybeSingle();
    if (data) return data as HrimsOrganogramPosition;
  }
  return null;
}

/** Position + employee variants of the CEO and its direct reports (HRIMS only). */
export async function fetchExecutivePositions(): Promise<
  Array<{ id: string; position_title: string; employee: HrimsEmployee | null }>
> {
  if (!hrimsClient) return [];
  const ceoPos = await findCeoPosition();
  if (!ceoPos) return [];

  const { data: directReports } = await hrimsClient
    .from('organogram_positions')
    .select('id, position_title, employee_id, is_active')
    .eq('parent_position_id', ceoPos.id)
    .eq('is_active', true);

  const positions: Array<{ id: string; position_title: string; employee_id: string | null }> = [
    { id: ceoPos.id, position_title: ceoPos.position_title, employee_id: ceoPos.employee_id },
    ...((directReports as any[]) || []).map((p) => ({
      id: p.id,
      position_title: p.position_title,
      employee_id: p.employee_id,
    })),
  ];

  const result: Array<{ id: string; position_title: string; employee: HrimsEmployee | null }> = [];
  for (const pos of positions) {
    const employee = await employeeForPosition(pos.id, pos.employee_id);
    result.push({ id: pos.id, position_title: pos.position_title, employee });
  }
  return result;
}
