import { NextApiRequest, NextApiResponse } from 'next';
import { getServerSession } from 'next-auth';
import { authOptions } from '../auth/[...nextauth]';
import { findEmployeeByPositionTitle, hrimsClient, HrimsEmployee } from '@/lib/hrimsClient';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { getDirectoryUserByEmail, isGraphDirectoryConfigured } from '@/lib/graphDirectory';
import { getValidMsAccessToken } from '@/lib/msTokenStore';

interface ResolvedApprover {
  userId: string;
  displayName: string;
  email: string;
  positionTitle: string;
  source: 'organogram_chain' | 'position_title' | 'circle_profile';
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const session = await getServerSession(req, res, authOptions);

    if (!session?.user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { email, formType } = req.query;
    const user = session.user as any;
    const organizationId = user.org_id;
    const sessionUserId = user.id;

    if (!email || typeof email !== 'string') {
      return res.status(400).json({ error: 'Requestor email is required' });
    }

    if (!formType || typeof formType !== 'string') {
      return res.status(400).json({ error: 'Form type is required (travel, hotel-booking, voucher, capex, petty-cash)' });
    }

    if (!organizationId) {
      return res.status(400).json({ error: 'Organization ID not found' });
    }

    // Whether we may fall back to Azure AD to provision an approver who has
    // never signed in. Tied to the same flag as the user picker so behaviour is
    // consistent across environments (production only).
    const canProvisionFromAzure =
      process.env.USER_DIRECTORY_SOURCE === 'azure' && isGraphDirectoryConfigured();

    // Delegated Graph token of the signed-in requester. The directory lookup for
    // an unprovisioned approver runs on this token (no app-only credential), so
    // it inherits the caller's Conditional-Access-compliant session. Resolved
    // once and reused across the many findAppUserByEmail calls below.
    const delegatedGraphToken = canProvisionFromAzure
      ? await getValidMsAccessToken(sessionUserId)
      : null;

    // Helper: find an app_user by their email within the organization.
    // Falls back to Azure AD provisioning so approvers who exist in HRIMS/AD but
    // have never signed into The Circle still resolve. The provisioned row is
    // keyed on the real azure_oid, so a later interactive sign-in reuses it
    // rather than creating a duplicate (no-op when Graph is unreachable).
    async function findAppUserByEmail(empEmail: string): Promise<{ id: string; display_name: string; email: string } | null> {
      const { data } = await supabaseAdmin
        .from('app_users')
        .select('id, display_name, email')
        .eq('organization_id', organizationId)
        .ilike('email', empEmail)
        .limit(1)
        .maybeSingle();

      if (data) return data;

      if (!canProvisionFromAzure || !delegatedGraphToken) return null;

      const dirUser = await getDirectoryUserByEmail(delegatedGraphToken, empEmail);
      if (!dirUser?.azureOid || !dirUser.email) return null;

      const { data: provisioned, error: provisionError } = await supabaseAdmin
        .from('app_users')
        .upsert(
          {
            organization_id: organizationId,
            azure_oid: dirUser.azureOid,
            email: dirUser.email,
            display_name: dirUser.displayName,
            job_title: dirUser.jobTitle,
          },
          { onConflict: 'organization_id,azure_oid' }
        )
        .select('id, display_name, email')
        .single();

      if (provisionError || !provisioned) {
        console.error('resolve-approvers: failed to provision app_user for', empEmail, provisionError?.message);
        return null;
      }
      return provisioned;
    }

    // Helper: find the employee assigned to a position (via current_position_id or employee_id)
    async function findEmployeeForPosition(positionId: string, employeeIdOnPosition?: string | null): Promise<HrimsEmployee | null> {
      // Primary: find employee whose current_position_id matches this position
      const { data: empByPos } = await hrimsClient
        .from('employees')
        .select('id, first_name, last_name, email, phone, job_title, employee_number, employment_status, manager_id, department_id, business_unit_id, current_position_id')
        .eq('current_position_id', positionId)
        .eq('employment_status', 'active')
        .limit(1)
        .single();

      if (empByPos) return empByPos as HrimsEmployee;

      // Fallback: use the employee_id on the position
      if (employeeIdOnPosition) {
        const { data: empById } = await hrimsClient
          .from('employees')
          .select('id, first_name, last_name, email, phone, job_title, employee_number, employment_status, manager_id, department_id, business_unit_id, current_position_id')
          .eq('id', employeeIdOnPosition)
          .eq('employment_status', 'active')
          .single();

        if (empById) return empById as HrimsEmployee;
      }

      return null;
    }

    // Helper: resolve a role by position title
    async function resolveByPositionTitle(title: string): Promise<ResolvedApprover | null> {
      const result = await findEmployeeByPositionTitle(title);
      if (!result?.employee?.email) return null;

      const appUser = await findAppUserByEmail(result.employee.email);
      if (!appUser) return null;

      return {
        userId: appUser.id,
        displayName: appUser.display_name,
        email: appUser.email,
        positionTitle: result.position.position_title,
        source: 'position_title',
      };
    }

    // Helper: resolve the requestor's line manager from their Circle profile.
    // Used when the requestor isn't in HRIMS (Azure-AD-only joiner) so their
    // manually-chosen "reports to" still populates the Line Manager step. Once
    // they exist in HRIMS the organogram chain resolves this instead.
    async function resolveCircleLineManager(): Promise<ResolvedApprover | null> {
      const { data: me } = await supabaseAdmin
        .from('app_users')
        .select('reports_to_user_id')
        .eq('organization_id', organizationId)
        .ilike('email', email as string)
        .maybeSingle();

      if (!me?.reports_to_user_id) return null;

      const { data: mgr } = await supabaseAdmin
        .from('app_users')
        .select('id, display_name, email, job_title')
        .eq('id', me.reports_to_user_id)
        .maybeSingle();

      if (!mgr) return null;

      return {
        userId: mgr.id,
        displayName: mgr.display_name,
        email: mgr.email,
        positionTitle: mgr.job_title || 'Line Manager',
        source: 'circle_profile',
      };
    }

    // Helper: try several position titles concurrently and return the
    // highest-priority match (array order = priority). Running the fallback
    // variants in parallel instead of sequentially is the main latency win —
    // a role with four title variants used to cost four serial round-trips.
    async function resolveFirstPositionTitle(titles: string[]): Promise<ResolvedApprover | null> {
      const results = await Promise.all(titles.map((t) => resolveByPositionTitle(t)));
      return results.find((r) => r) || null;
    }

    // Helper: build a resolved approver from an HRIMS employee
    async function buildApprover(emp: HrimsEmployee, positionTitle: string, source: 'organogram_chain' | 'position_title'): Promise<ResolvedApprover | null> {
      const appUser = await findAppUserByEmail(emp.email);
      if (!appUser) return null;

      return {
        userId: appUser.id,
        displayName: appUser.display_name,
        email: appUser.email,
        positionTitle,
        source,
      };
    }

    const approvers: Record<string, ResolvedApprover | null> = {};
    const debug: string[] = [];

    if (!hrimsClient) {
      console.error('HRIMS client not configured - missing environment variables');
      return res.status(200).json({ approvers });
    }

    debug.push(`Resolving approvers for email="${email}", formType="${formType}"`);

    if (formType === 'travel' || formType === 'hotel-booking') {
      // Find the requestor's employee and position in HRIMS (case-insensitive email match)
      const { data: requestorEmp, error: reqError } = await hrimsClient
        .from('employees')
        .select('id, first_name, last_name, email, current_position_id')
        .ilike('email', email)
        .eq('employment_status', 'active')
        .single();

      if (reqError) {
        debug.push(`FAIL: requestor lookup error: ${reqError.message} (code: ${reqError.code})`);
        console.error('Failed to find requestor in HRIMS:', email, reqError.message, reqError.code);
      }

      if (requestorEmp) {
        debug.push(`OK: Found requestor: ${requestorEmp.first_name} ${requestorEmp.last_name} (${requestorEmp.email}), position_id=${requestorEmp.current_position_id}`);
      } else {
        debug.push(`FAIL: No employee found for email="${email}"`);
        // Try a broader search to see what emails exist
        const { data: similarEmps } = await hrimsClient
          .from('employees')
          .select('email, first_name, last_name')
          .eq('employment_status', 'active')
          .limit(20);
        if (similarEmps) {
          debug.push(`Available HRIMS emails: ${similarEmps.map(e => e.email).join(', ')}`);
        }
      }

      if (requestorEmp?.current_position_id) {
        // Get the requestor's position to find parent
        const { data: requestorPos, error: posError } = await hrimsClient
          .from('organogram_positions')
          .select('id, position_title, parent_position_id')
          .eq('id', requestorEmp.current_position_id)
          .single();

        if (posError) {
          debug.push(`FAIL: requestor position lookup error: ${posError.message}`);
        }
        if (requestorPos) {
          debug.push(`OK: Requestor position: "${requestorPos.position_title}" (id=${requestorPos.id}), parent=${requestorPos.parent_position_id}`);
        } else {
          debug.push(`FAIL: No position found for id=${requestorEmp.current_position_id}`);
        }

        if (requestorPos?.parent_position_id) {
          // Line Manager = immediate parent position (requestor's HOD)
          const { data: lineManagerPos, error: lmPosError } = await hrimsClient
            .from('organogram_positions')
            .select('id, position_title, parent_position_id, employee_id')
            .eq('id', requestorPos.parent_position_id)
            .eq('is_active', true)
            .single();

          if (lmPosError) {
            debug.push(`FAIL: line manager position lookup error: ${lmPosError.message}`);
          }
          if (lineManagerPos) {
            debug.push(`OK: Line Manager position: "${lineManagerPos.position_title}" (id=${lineManagerPos.id}), employee_id=${lineManagerPos.employee_id}`);
          } else {
            debug.push(`FAIL: No active position found for parent id=${requestorPos.parent_position_id}`);
          }

          if (lineManagerPos) {
            const lmEmp = await findEmployeeForPosition(lineManagerPos.id, lineManagerPos.employee_id);
            if (lmEmp) {
              debug.push(`OK: Line Manager employee: ${lmEmp.first_name} ${lmEmp.last_name} (${lmEmp.email}), current_position_id=${lmEmp.current_position_id}`);
              const lmApprover = await buildApprover(lmEmp, lineManagerPos.position_title, 'organogram_chain');
              approvers.line_manager = lmApprover;
              if (!lmApprover) {
                debug.push(`FAIL: Line Manager employee found in HRIMS but no matching app_user for email="${lmEmp.email}"`);
              } else {
                debug.push(`OK: Line Manager resolved to app_user: ${lmApprover.displayName} (${lmApprover.userId})`);
              }
            } else {
              debug.push(`FAIL: No employee found for Line Manager position id=${lineManagerPos.id}`);
              // Check what employees have current_position_id set
              const { data: allEmps } = await hrimsClient
                .from('employees')
                .select('id, first_name, last_name, email, current_position_id')
                .eq('employment_status', 'active')
                .not('current_position_id', 'is', null);
              if (allEmps) {
                debug.push(`Employees with positions: ${allEmps.map(e => `${e.first_name} ${e.last_name} -> pos:${e.current_position_id}`).join('; ')}`);
              }
            }

            // Functional Manager = the position the Line Manager reports to (one level above LM)
            if (lineManagerPos.parent_position_id) {
              const { data: funcManagerPos } = await hrimsClient
                .from('organogram_positions')
                .select('id, position_title, employee_id')
                .eq('id', lineManagerPos.parent_position_id)
                .eq('is_active', true)
                .single();

              if (funcManagerPos) {
                debug.push(`OK: Functional Manager position: "${funcManagerPos.position_title}" (id=${funcManagerPos.id})`);
                const fmEmp = await findEmployeeForPosition(funcManagerPos.id, funcManagerPos.employee_id);
                if (fmEmp) {
                  approvers.functional_head = await buildApprover(fmEmp, funcManagerPos.position_title, 'organogram_chain');
                  debug.push(`OK: Functional Manager resolved: ${fmEmp.first_name} ${fmEmp.last_name}`);
                } else {
                  debug.push(`FAIL: No employee for Functional Manager position (vacant)`);
                }
              }
            }
          }
        }
      }

      // HRD = find by position title.
      // 2026 organogram: "HR Director" is now "Chief Human Capital Officer".
      // Search the new title first, fall back to the legacy titles. HRD and CEO
      // are independent of each other and of the organogram chain above, so
      // resolve them (and their title variants) concurrently.
      const [hrd, ceo] = await Promise.all([
        resolveFirstPositionTitle([
          'Chief Human Capital Officer',
          'Human Resources Director',
          'HR Director',
          'Director of Human Resources',
        ]),
        resolveFirstPositionTitle(['CEO', 'Chief Executive Officer']),
      ]);
      approvers.hrd = hrd;
      approvers.ceo = ceo;

      // Line Manager fallback: if the requestor isn't in HRIMS (so the
      // organogram chain above couldn't run), use who they told us they report
      // to during onboarding, stored on their Circle profile.
      if (!approvers.line_manager) {
        approvers.line_manager = await resolveCircleLineManager();
        if (approvers.line_manager) {
          debug.push(`OK: Line Manager resolved from Circle profile: ${approvers.line_manager.displayName}`);
        }
      }

    } else if (formType === 'capex') {
      // Head of Department — resolve the head of the requestor's own department.
      // Resolution order:
      //   1. departments.department_head_id (authoritative HRIMS source)
      //   2. Organogram positions tagged with department_id whose title looks like a head
      //   3. Walk up the requestor's position chain for a head-like title (skipping direct line manager)
      const resolveDepartmentHead = async (): Promise<ResolvedApprover | null> => {
        const { data: requestorEmp } = await hrimsClient
          .from('employees')
          .select('id, first_name, last_name, email, current_position_id, department_id')
          .ilike('email', email)
          .eq('employment_status', 'active')
          .single();

        let resolved: ResolvedApprover | null = null;

        // 1. Authoritative source: the department row itself names the head
        if (requestorEmp?.department_id) {
          const { data: dept } = await hrimsClient
            .from('departments')
            .select('id, name, code, department_head_id')
            .eq('id', requestorEmp.department_id)
            .single();

          if (dept?.department_head_id && dept.department_head_id !== requestorEmp.id) {
            const { data: headEmp } = await hrimsClient
              .from('employees')
              .select('id, first_name, last_name, email, phone, job_title, employee_number, employment_status, manager_id, department_id, business_unit_id, current_position_id')
              .eq('id', dept.department_head_id)
              .eq('employment_status', 'active')
              .single();

            if (headEmp) {
              const title = headEmp.job_title || `Head of ${dept.name}`;
              resolved = await buildApprover(headEmp as HrimsEmployee, title, 'organogram_chain');
            }
          }
        }

        // 2. Department-tagged organogram position with a head-like title
        if (!resolved && requestorEmp?.department_id) {
          const { data: deptPositions } = await hrimsClient
            .from('organogram_positions')
            .select('id, position_title, employee_id, department_id, is_active, level')
            .eq('department_id', requestorEmp.department_id)
            .eq('is_active', true)
            .order('level', { ascending: true });

          if (deptPositions && deptPositions.length > 0) {
            const headCandidate = deptPositions.find(p =>
              p.id !== requestorEmp.current_position_id &&
              /head\s+of|hod|director|general\s+manager/i.test(p.position_title || '')
            ) || deptPositions.find(p =>
              p.id !== requestorEmp.current_position_id &&
              /manager|chief/i.test(p.position_title || '')
            );

            if (headCandidate) {
              const headEmp = await findEmployeeForPosition(headCandidate.id, headCandidate.employee_id);
              if (headEmp && headEmp.id !== requestorEmp.id) {
                resolved = await buildApprover(headEmp, headCandidate.position_title, 'organogram_chain');
              }
            }
          }
        }

        // 3. Walk up the organogram chain as a last resort
        if (!resolved && requestorEmp?.current_position_id) {
          let currentPosId: string | null = requestorEmp.current_position_id;
          let safety = 0;

          while (currentPosId && safety < 10 && !resolved) {
            safety++;
            const { data: pos } = await hrimsClient
              .from('organogram_positions')
              .select('id, position_title, parent_position_id, employee_id, is_active')
              .eq('id', currentPosId)
              .single();

            if (!pos) break;

            if (pos.id !== requestorEmp.current_position_id && pos.is_active) {
              const title = (pos.position_title || '').toLowerCase();
              const looksLikeHead = /head\s+of|hod|director|general\s+manager|chief/i.test(title);
              if (looksLikeHead) {
                const headEmp = await findEmployeeForPosition(pos.id, pos.employee_id);
                if (headEmp && headEmp.id !== requestorEmp.id) {
                  resolved = await buildApprover(headEmp, pos.position_title, 'organogram_chain');
                  break;
                }
              }
            }

            currentPosId = pos.parent_position_id;
          }
        }

        return resolved;
      };

      // Every capex approver is independent, so resolve them all concurrently
      // (each title variant list resolves its own fallbacks in parallel too).
      const [
        finance_manager,
        general_manager,
        procurement_manager,
        corporate_hod,
        managing_director,
        finance_director,
        capexCeo,
      ] = await Promise.all([
        resolveFirstPositionTitle(['Finance Manager', 'Accountant']),
        resolveDepartmentHead(),
        // Procurement and Projects Manager is one person; match either title variant.
        resolveFirstPositionTitle(['Procurement and Projects Manager', 'Procurement Manager', 'Head of Procurement', 'Projects Manager', 'Project Manager']),
        resolveFirstPositionTitle(['Corporate Head of Department', 'Head of Department']),
        resolveFirstPositionTitle(['Chief Operating Officer', 'COO', 'Managing Director', 'MD']),
        resolveFirstPositionTitle(['Chief Finance Officer', 'CFO', 'Finance Director', 'Director of Finance']),
        resolveFirstPositionTitle(['CEO', 'Chief Executive Officer']),
      ]);
      approvers.finance_manager = finance_manager;
      approvers.general_manager = general_manager;
      approvers.procurement_manager = procurement_manager;
      approvers.corporate_hod = corporate_hod;
      approvers.managing_director = managing_director;
      approvers.finance_director = finance_director;
      approvers.ceo = capexCeo;

    } else if (formType === 'voucher') {
      // Commercial Director + CEO are independent — resolve concurrently.
      const [commercial_director, voucherCeo] = await Promise.all([
        resolveFirstPositionTitle(['Chief Commercial Officer', 'Commercial Director', 'Director of Commercial']),
        resolveFirstPositionTitle(['CEO', 'Chief Executive Officer']),
      ]);
      approvers.commercial_director = commercial_director;
      approvers.ceo = voucherCeo;
    } else if (formType === 'petty-cash') {
      // Petty cash workflow: Department Head -> Accountant -> Finance Manager (sequential)

      // Department Head — head of the requestor's own department.
      // Resolution mirrors the capex branch: departments.department_head_id is authoritative.
      const resolvePettyDepartmentHead = async (): Promise<ResolvedApprover | null> => {
        const { data: requestorEmp } = await hrimsClient
          .from('employees')
          .select('id, first_name, last_name, email, current_position_id, department_id')
          .ilike('email', email)
          .eq('employment_status', 'active')
          .single();

        let resolved: ResolvedApprover | null = null;

        if (requestorEmp?.department_id) {
          const { data: dept } = await hrimsClient
            .from('departments')
            .select('id, name, code, department_head_id')
            .eq('id', requestorEmp.department_id)
            .single();

          if (dept?.department_head_id && dept.department_head_id !== requestorEmp.id) {
            const { data: headEmp } = await hrimsClient
              .from('employees')
              .select('id, first_name, last_name, email, phone, job_title, employee_number, employment_status, manager_id, department_id, business_unit_id, current_position_id')
              .eq('id', dept.department_head_id)
              .eq('employment_status', 'active')
              .single();

            if (headEmp) {
              const title = headEmp.job_title || `Head of ${dept.name}`;
              resolved = await buildApprover(headEmp as HrimsEmployee, title, 'organogram_chain');
            }
          }
        }

        // Fallback: walk up the organogram chain looking for a head-like title
        if (!resolved && requestorEmp?.current_position_id) {
          let currentPosId: string | null = requestorEmp.current_position_id;
          let safety = 0;

          while (currentPosId && safety < 10 && !resolved) {
            safety++;
            const { data: pos } = await hrimsClient
              .from('organogram_positions')
              .select('id, position_title, parent_position_id, employee_id, is_active')
              .eq('id', currentPosId)
              .single();

            if (!pos) break;

            if (pos.id !== requestorEmp.current_position_id && pos.is_active) {
              const title = (pos.position_title || '').toLowerCase();
              const looksLikeHead = /head\s+of|hod|director|general\s+manager|chief/i.test(title);
              if (looksLikeHead) {
                const headEmp = await findEmployeeForPosition(pos.id, pos.employee_id);
                if (headEmp && headEmp.id !== requestorEmp.id) {
                  resolved = await buildApprover(headEmp, pos.position_title, 'organogram_chain');
                  break;
                }
              }
            }

            currentPosId = pos.parent_position_id;
          }
        }

        return resolved;
      };

      const [department_head, accountant, pettyFinanceManager] = await Promise.all([
        resolvePettyDepartmentHead(),
        resolveFirstPositionTitle(['Accountant', 'Senior Accountant', 'Group Accountant']),
        resolveFirstPositionTitle(['Finance Manager', 'Head of Finance', 'Finance Director']),
      ]);
      approvers.department_head = department_head;
      approvers.accountant = accountant;
      approvers.finance_manager = pettyFinanceManager;
    } else if (formType === 'inter-unit-debit-note' || formType === 'inter-unit-credit-note') {
      // Inter-unit debit note: From Unit Accountant (the requestor signs themselves) ->
      // From Unit Finance Manager -> Receiving Unit Accountant.
      // Receiving-unit lookup is scoped by the toUnitCode query param so the
      // accountant comes from the correct hotel/business unit.
      const toUnitCode = typeof req.query.toUnit === 'string' ? req.query.toUnit.trim() : '';

      // From-side finance manager — same resolution as petty-cash, but scoped
      // to the requestor's own business unit when we can find it.
      const { data: requestorEmp } = await hrimsClient
        .from('employees')
        .select('id, first_name, last_name, email, business_unit_id')
        .ilike('email', email)
        .eq('employment_status', 'active')
        .single();

      const fromBuId = requestorEmp?.business_unit_id;

      const tryFromTitles = ['Finance Manager', 'Head of Finance', 'Finance Director'];
      for (const title of tryFromTitles) {
        // Try within-unit first, then organisation-wide as fallback.
        let result = fromBuId
          ? await findEmployeeByPositionTitle(title, fromBuId)
          : null;
        if (!result) result = await findEmployeeByPositionTitle(title);
        if (result?.employee?.email) {
          const appUser = await findAppUserByEmail(result.employee.email);
          if (appUser) {
            approvers.from_finance_manager = {
              userId: appUser.id,
              displayName: appUser.display_name,
              email: appUser.email,
              positionTitle: result.position.position_title,
              source: 'position_title',
            };
            break;
          }
        }
      }

      // Receiving-unit accountant — resolution requires the receiving unit code.
      if (toUnitCode) {
        const { data: toBu } = await hrimsClient
          .from('business_units')
          .select('id, code')
          .ilike('code', toUnitCode)
          .eq('is_active', true)
          .single();

        const toBuId = toBu?.id;

        const tryToTitles = ['Accountant', 'Senior Accountant', 'Unit Accountant', 'Group Accountant'];
        for (const title of tryToTitles) {
          if (!toBuId) break;
          const result = await findEmployeeByPositionTitle(title, toBuId);
          if (result?.employee?.email) {
            const appUser = await findAppUserByEmail(result.employee.email);
            if (appUser) {
              approvers.to_accountant = {
                userId: appUser.id,
                displayName: appUser.display_name,
                email: appUser.email,
                positionTitle: result.position.position_title,
                source: 'position_title',
              };
              break;
            }
          }
        }
      }
    } else {
      return res.status(400).json({ error: 'Invalid form type. Must be: travel, hotel-booking, voucher, capex, petty-cash, inter-unit-debit-note, or inter-unit-credit-note' });
    }

    console.log('[resolve-approvers] Debug trace:', debug.join(' | '));
    return res.status(200).json({ approvers, _debug: debug });
  } catch (error: any) {
    console.error('HRIMS Resolve Approvers API error:', error);
    return res.status(500).json({ error: error.message || 'Failed to resolve approvers' });
  }
}
