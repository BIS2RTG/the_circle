import { NextApiRequest, NextApiResponse } from 'next';
import { getServerSession } from 'next-auth';
import { authOptions } from '../../auth/[...nextauth]';
import { supabaseAdmin } from '../../../../lib/supabaseAdmin';
import { signatureExists, userSignaturePath, userSignatureProxyUrl } from '../../../../lib/signatureStorage';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const session = await getServerSession(req, res, authOptions);
    
    if (!session?.user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const user = session.user as any;
    const organizationId = user.org_id;
    const { id } = req.query;

    if (!organizationId) {
      return res.status(400).json({ error: 'Organization ID not found' });
    }

    if (!id || typeof id !== 'string') {
      return res.status(400).json({ error: 'Request ID is required' });
    }

    const userId = user.id;
    
    // Fetch the request with all related data
    const { data: request, error } = await supabaseAdmin
      .from('requests')
      .select(`
        id,
        title,
        description,
        status,
        metadata,
        created_at,
        updated_at,
        creator_id,
        creator:app_users!requests_creator_id_fkey (
          id,
          display_name,
          email,
          department_id,
          job_title
        ),
        request_steps (
          id,
          step_index,
          step_type,
          approver_role,
          approver_user_id,
          status,
          due_at,
          created_at,
          approver:app_users!request_steps_approver_user_id_fkey (
            id,
            display_name,
            email,
            job_title,
            signature_url
          ),
          approvals (
            id,
            decision,
            comment,
            signed_at,
            approver:app_users!approvals_approver_id_fkey (
              id,
              display_name,
              email
            )
          )
        )
      `)
      .eq('id', id)
      .eq('organization_id', organizationId)
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        return res.status(404).json({ error: 'Request not found' });
      }
      throw error;
    }

    // Check if request is fully approved
    if (request.status !== 'approved') {
      return res.status(400).json({ error: 'Voucher can only be generated for fully approved requests' });
    }

    // Check if this is a voucher_request type
    const requestType = request.metadata?.type || request.metadata?.requestType;
    if (requestType !== 'voucher_request' && requestType !== 'hotel_booking') {
      return res.status(400).json({ error: 'This endpoint is only for complimentary voucher requests' });
    }

    // Visibility check
    const isCreator = request.creator_id === userId;
    const watcherIds = request.metadata?.watchers || [];
    const isWatcher = Array.isArray(watcherIds) && watcherIds.some((w: any) => 
      typeof w === 'string' ? w === userId : w?.id === userId
    );
    const userStep = request.request_steps?.find(
      (step: any) => step.approver_user_id === userId
    );
    const canApproverView = userStep && userStep.status !== 'waiting';
    
    if (!isCreator && !isWatcher && !canApproverView) {
      return res.status(403).json({ error: 'You do not have permission to view this request' });
    }

    // Resolve signatures for each approval step. This HTML is rendered in the
    // browser (authenticated session), so the private-bucket proxy URL is used.
    for (const step of (request.request_steps || [])) {
      if (step.approver_user_id) {
        if (await signatureExists(userSignaturePath(step.approver_user_id))) {
          (step as any).resolved_signature_url = userSignatureProxyUrl(step.approver_user_id);
        }
      }
    }

    // Generate HTML for voucher PDF
    const html = generateVoucherHtml(request);

    // Return HTML that can be printed/saved as PDF
    res.setHeader('Content-Type', 'text/html');
    res.setHeader('Content-Disposition', `inline; filename="voucher-${id}.html"`);
    return res.status(200).send(html);
  } catch (error: any) {
    console.error('Voucher PDF generation error:', error);
    return res.status(500).json({ error: error.message || 'Failed to generate voucher PDF' });
  }
}

function generateVoucherHtml(request: any): string {
  const metadata = request.metadata || {};
  
  // Get the final approval date (when the request was fully approved)
  const sortedSteps = [...(request.request_steps || [])].sort((a: any, b: any) => b.step_index - a.step_index);
  const lastApproval = sortedSteps.find((step: any) => step.status === 'approved')?.approvals?.[0];
  const approvalDate = lastApproval?.signed_at ? new Date(lastApproval.signed_at) : new Date(request.updated_at);
  
  const formatDate = (date: Date) => {
    return date.toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' });
  };

  // Calculate expiry date (3 months from approval)
  const expiryDate = new Date(approvalDate);
  expiryDate.setMonth(expiryDate.getMonth() + 3);

  // Generate voucher number
  const voucherNumber = metadata.voucherNumber || `VCH-${request.id.substring(0, 8).toUpperCase()}`;

  // Get guest name if the checkbox was selected
  const showNameOnVoucher = metadata.showNameOnVoucher !== false;
  const guestNames = metadata.guestNames || metadata.guestName || '';
  const guestTitle = metadata.guestTitle || '';
  const guestFirstName = metadata.guestFirstName || '';
  const isExternalGuest = metadata.isExternalGuest === true;

  // Get accommodation details from metadata
  const selectedBusinessUnits = metadata.selectedBusinessUnits || [];
  
  // Check if this is a meal-only voucher
  const mealOnlyTypes = ['meals_all', 'rainbow_delights', 'breakfast_only', 'lunch_only', 'dinner_only', 'packed_breakfast', 'packed_lunch'];
  const firstUnit = selectedBusinessUnits[0] || {};
  const isMealOnly = mealOnlyTypes.includes(firstUnit.accommodationType);
  
  const accommodationType = selectedBusinessUnits.length > 0 
    ? selectedBusinessUnits.map((u:any) => u.accommodationType?.replace(/_/g, ' ')).filter(Boolean).join(', ') 
    : (metadata.accommodationType || 'Bed & Breakfast Only');
    
  const roomType = selectedBusinessUnits.length > 0
    ? selectedBusinessUnits.map((u:any) => u.roomType).filter(Boolean).join(', ')
    : (metadata.roomType || 'One Double Room Only');
    
  const hotelName = selectedBusinessUnits.length > 0
    ? selectedBusinessUnits.map((u:any) => u.name).filter(Boolean).join(', ')
    : (metadata.hotelName || metadata.hotel || "A'Zambezi River Lodge");
    
  const numberOfNights = selectedBusinessUnits.length > 0
    ? selectedBusinessUnits.map((u:any) => u.voucherValidityPeriod).filter(Boolean).join(', ')
    : (metadata.numberOfNights || metadata.nights || 'One Night Only');

  // numberOfRooms in the form is actually "number of nights"
  const numberOfNightsFromUnit = firstUnit.numberOfRooms || '1';
  
  // numberOfPeople - get directly from firstUnit to avoid join issues
  const numberOfPeopleFromUnit = firstUnit.numberOfPeople || '2';

  // Meal-specific details
  const numberOfMeals = firstUnit.numberOfMeals || '1';
  const mealPeopleCount = firstUnit.mealPeopleCount || '1';

  const specialArrangements = selectedBusinessUnits.length > 0
    ? selectedBusinessUnits.map((u:any) => u.specialArrangements).filter(Boolean).join(', ')
    : 'N/A';

  const allocationType = metadata.allocationType || 'N/A';
  const rtgLogoUrl = '/images/RTG_LOGO.png';
  
  // Check if RTG South Africa is selected
  const isRTGSouthAfrica = selectedBusinessUnits.some((u: any) => 
    u.name?.toLowerCase().includes('south africa') || 
    u.name?.toLowerCase().includes('rsa') ||
    u.id?.toLowerCase().includes('south-africa')
  );
  
  // Contact details based on region
  const emailSubject = `Voucher Reservation - ${voucherNumber}`;
  const emailBody = `Dear Reservations Team,

I would like to make a reservation using my complimentary voucher.

Voucher Number: ${voucherNumber}
Guest Name: ${guestNames || 'As per voucher'}
Hotel: ${hotelName}

Preferred Check-in Date: [Please specify]
Preferred Check-out Date: [Please specify]

Please confirm availability.

Kind regards`;

  const contactDetails = isRTGSouthAfrica 
    ? {
        phone: '+27 11 463 4470',
        email: 'reservations@rtgrsa.co.za',
        mailtoHref: `mailto:reservations@rtgrsa.co.za?subject=${encodeURIComponent(emailSubject)}&body=${encodeURIComponent(emailBody)}`
      }
    : {
        phone: '+263-4-772613 or +263-4-772633',
        email: 'reservations@rtg.co.zw',
        mailtoHref: `mailto:reservations@rtg.co.zw?subject=${encodeURIComponent(emailSubject)}&body=${encodeURIComponent(emailBody)}`
      };
  
  // Format accommodation type for display
  const formatAccommodationType = (type: string) => {
    const typeMap: Record<string, string> = {
      'accommodation only': 'Accommodation Only (Bed only)',
      'accommodation and breakfast': 'Bed & Breakfast',
      'accommodation and meals': 'Accommodation & Meals (Breakfast, Lunch, and Dinner',
      'accommodation meals drink': 'Accommodation, Meals plus a Soft Drink/Juice',
      'meals all': 'Meals (Breakfast, Lunch and Dinner)',
      'rainbow delights': 'Rainbow Delights Meal(s)',
      'breakfast only': 'Breakfast',
      'lunch only': 'Lunch',
      'dinner only': 'Dinner',
      'packed breakfast': 'Packed Breakfast',
      'packed lunch': 'Packed Lunch',
      'dinner bed breakfast': 'Dinner, Bed & Breakfast',
    };
    return typeMap[type.toLowerCase()] || type;
  };

  // Handle approver being an array (Supabase join behavior)
  const getApproverField = (step: any, field: string) => {
    if (!step?.approver) return null;
    const approver = Array.isArray(step.approver) ? step.approver[0] : step.approver;
    return approver?.[field] || null;
  };

  // Get all approved steps sorted by step_index
  const approvedSteps = (request.request_steps || [])
    .filter((s: any) => s.status === 'approved')
    .sort((a: any, b: any) => a.step_index - b.step_index);

  // Try to find Commercial Director and CEO by role in metadata first
  const commercialDirectorId = metadata.approverRoles?.commercial_director;
  const ceoId = metadata.approverRoles?.ceo;
  
  let commercialDirectorStep = approvedSteps.find((s: any) => s.approver_user_id === commercialDirectorId);
  let ceoStep = approvedSteps.find((s: any) => s.approver_user_id === ceoId);

  // Fallback: if not found by role ID, use the last two approved steps
  // (typically the higher-level approvers sign last)
  if (!commercialDirectorStep && approvedSteps.length >= 2) {
    commercialDirectorStep = approvedSteps[approvedSteps.length - 2];
  }
  if (!ceoStep && approvedSteps.length >= 1) {
    ceoStep = approvedSteps[approvedSteps.length - 1];
  }
  
  // If only one approver, use them for both (edge case)
  if (!commercialDirectorStep && ceoStep) {
    commercialDirectorStep = ceoStep;
  }
  
  const commercialDirectorName = getApproverField(commercialDirectorStep, 'display_name') || "Commercial Director";
  // The first approver is a generic "Approver" — its title on the voucher is the
  // selected user's own job title (falls back to "Approver" when unknown).
  const commercialDirectorTitle = getApproverField(commercialDirectorStep, 'job_title') || "Approver";
  const ceoName = getApproverField(ceoStep, 'display_name') || "CEO";
  
  // Get signatures - first try resolved_signature_url (from storage), then fallback to signature_url (from user record)
  const commercialDirectorSignature = commercialDirectorStep?.resolved_signature_url || getApproverField(commercialDirectorStep, 'signature_url');
  const ceoSignature = ceoStep?.resolved_signature_url || getApproverField(ceoStep, 'signature_url');
  
  // Generate grammatically correct entitlement text with all necessary details
  const generateEntitlementText = () => {
    const unit = firstUnit;
    const hotelDisplay = hotelName;
    const accType = unit.accommodationType || 'accommodation_only';
    // Use the direct values from firstUnit
    const nightsCount = numberOfNightsFromUnit;
    const guestsCount = numberOfPeopleFromUnit;
    const room = unit.roomType || roomType || 'Double room';
    const mealsCount = unit.numberOfMeals || numberOfMeals || '1';
    const mealGuests = unit.mealPeopleCount || mealPeopleCount || '1';
    
    // Helper for pluralization
    const nightText = parseInt(nightsCount) === 1 ? '1 night' : `${nightsCount} nights`;
    const guestText = parseInt(guestsCount) === 1 ? '1 guest' : `${guestsCount} guests`;
    const mealGuestText = parseInt(mealGuests) === 1 ? '1 guest' : `${mealGuests} guests`;
    const mealCountText = parseInt(mealsCount) === 1 ? '1 meal' : `${mealsCount} meals`;
    
    // Meal-only types
    if (mealOnlyTypes.includes(accType)) {
      const mealTypeLabels: Record<string, string> = {
        'meals_all': 'Breakfast, Lunch, and Dinner',
        'rainbow_delights': 'Rainbow Delights',
        'breakfast_only': 'Breakfast',
        'lunch_only': 'Lunch',
        'dinner_only': 'Dinner',
        'packed_breakfast': 'Packed Breakfast',
        'packed_lunch': 'Packed Lunch',
      };
      const mealLabel = mealTypeLabels[accType] || 'meals';
      return `This voucher entitles the bearer to <strong>${mealCountText}</strong> (<strong>${mealLabel}</strong>) for <strong>${mealGuestText}</strong> at <strong>${hotelDisplay}</strong>.`;
    }
    
    // Accommodation types - include nights, room type, and guests
    let entitlementParts: string[] = [];
    
    switch (accType) {
      case 'accommodation_only':
        entitlementParts.push(`<strong>${nightText}</strong> of <strong>Accommodation</strong> (bed only)`);
        entitlementParts.push(`in a <strong>${room}</strong>`);
        entitlementParts.push(`for <strong>${guestText}</strong>`);
        break;
      case 'accommodation_and_breakfast':
        entitlementParts.push(`<strong>${nightText}</strong> of <strong>Bed & Breakfast</strong>`);
        entitlementParts.push(`in a <strong>${room}</strong>`);
        entitlementParts.push(`for <strong>${guestText}</strong>`);
        break;
      case 'dinner_bed_breakfast':
        entitlementParts.push(`<strong>${nightText}</strong> of <strong>Dinner, Bed & Breakfast</strong>`);
        entitlementParts.push(`in a <strong>${room}</strong>`);
        entitlementParts.push(`for <strong>${guestText}</strong>`);
        break;
      case 'accommodation_and_meals':
        entitlementParts.push(`<strong>${nightText}</strong> of <strong>Accommodation</strong>`);
        entitlementParts.push(`in a <strong>${room}</strong>`);
        entitlementParts.push(`for <strong>${guestText}</strong>`);
        entitlementParts.push(`including <strong>Breakfast, Lunch, and Dinner</strong>`);
        break;
      case 'accommodation_meals_drink':
        entitlementParts.push(`<strong>${nightText}</strong> of <strong>Accommodation</strong>`);
        entitlementParts.push(`in a <strong>${room}</strong>`);
        entitlementParts.push(`for <strong>${guestText}</strong>`);
        entitlementParts.push(`including <strong>Meals and a Soft Drink</strong>`);
        break;
      default:
        entitlementParts.push(`<strong>${nightText}</strong> of <strong>${formatAccommodationType(accType)}</strong>`);
        entitlementParts.push(`in a <strong>${room}</strong>`);
        entitlementParts.push(`for <strong>${guestText}</strong>`);
    }
    
    return `This voucher entitles the bearer to ${entitlementParts.join(' ')} at <strong>${hotelDisplay}</strong>.`;
  };

  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>Complimentary Voucher - ${voucherNumber}</title>
  <link href="https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,400;0,600;0,700;1,400&family=Lato:wght@300;400;700&display=swap" rel="stylesheet">
  <style>
    @media print {
      body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
      .no-print { display: none !important; }
      @page { margin: 15mm; }
    }
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }
    body {
      font-family: 'Lato', sans-serif;
      line-height: 1.6;
      color: #333;
      max-width: 850px;
      margin: 0 auto;
      padding: 40px 20px;
      background: #f7f9fc;
    }
    .voucher-container {
      background: #ffffff;
      border-radius: 2px;
      padding: 50px 60px;
      position: relative;
      box-shadow: 0 10px 40px rgba(0,0,0,0.08);
      overflow: hidden;
    }
    /* Elegant inner border */
    .voucher-container::before {
      content: '';
      position: absolute;
      top: 15px;
      left: 15px;
      right: 15px;
      bottom: 15px;
      border: 1px solid #d4af37;
      pointer-events: none;
      border-radius: 2px;
    }
    .voucher-container::after {
      content: '';
      position: absolute;
      top: 20px;
      left: 20px;
      right: 20px;
      bottom: 20px;
      border: 1px solid rgba(212, 175, 55, 0.3);
      pointer-events: none;
      border-radius: 2px;
    }
    .header {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      margin-bottom: 40px;
      position: relative;
      z-index: 10;
    }
    .logo {
      max-width: 180px;
      max-height: 90px;
      object-fit: contain;
    }
    .voucher-details {
      text-align: right;
    }
    .voucher-number {
      font-size: 16px;
      color: #333;
      font-weight: 700;
      letter-spacing: 1px;
    }
    .issue-date {
      font-size: 13px;
      color: #666;
      margin-top: 4px;
    }
    .main-title {
      text-align: center;
      font-family: 'Lato', sans-serif;
      font-size: 28px;
      font-weight: 700;
      color: #1a1a1a;
      margin-bottom: 25px;
      text-transform: uppercase;
      letter-spacing: 3px;
      position: relative;
    }
    .main-title::after {
      content: '';
      display: block;
      width: 60px;
      height: 2px;
      background: #d4af37;
      margin: 15px auto 0;
    }
    .guest-section {
      text-align: center;
      margin-bottom: 35px;
    }
    .guest-label {
      font-family: 'Playfair Display', serif;
      font-size: 24px;
      color: #333;
      letter-spacing: 1px;
      margin-bottom: 5px;
      font-style: italic;
    }
    .guest-name {
      font-family: 'Playfair Display', serif;
      font-size: 28px;
      font-weight: 600;
      color: #000;
      font-style: italic;
    }
    .congratulations {
      text-align: center;
      font-size: 22px;
      font-weight: 700;
      color: #d4af37;
      margin-bottom: 20px;
      letter-spacing: 2px;
    }
    .entitlement-box {
      background: #fafafa;
      border-left: 4px solid #d4af37;
      padding: 25px 30px;
      margin-bottom: 35px;
      text-align: center;
      line-height: 1.8;
      font-size: 16px;
      color: #444;
      border-radius: 0 4px 4px 0;
    }
    .entitlement-box strong {
      color: #111;
      font-weight: 700;
    }
    .terms-section {
      margin-bottom: 40px;
      padding: 0 20px;
    }
    .terms-title {
      font-family: 'Playfair Display', serif;
      font-size: 18px;
      font-weight: 600;
      color: #111;
      margin-bottom: 15px;
      text-transform: uppercase;
      letter-spacing: 1px;
    }
    .terms-list {
      list-style: none;
    }
    .terms-list li {
      position: relative;
      padding-left: 20px;
      margin-bottom: 12px;
      font-size: 14px;
      color: #555;
    }
    .terms-list li::before {
      content: '⋄';
      position: absolute;
      left: 0;
      color: #d4af37;
      font-weight: bold;
      font-size: 18px;
      line-height: 1;
      top: -1px;
    }
    .terms-list li.expired-warning {
      color: #e53e3e;
      font-weight: 700;
      font-size: 16px;
    }
    .terms-list li.expired-warning::before {
      color: #e53e3e;
    }
    .signatures-container {
      display: flex;
      justify-content: space-around;
      margin-top: 50px;
      margin-bottom: 40px;
      padding: 0 20px;
      position: relative;
      z-index: 10;
      gap: 40px;
    }
    .signature-block {
      width: 45%;
      text-align: center;
    }
    .signature-image-container {
      height: 80px;
      display: flex;
      align-items: flex-end;
      justify-content: center;
      margin-bottom: 5px;
      padding: 0;
    }
    .signature-image-container img {
      max-height: 75px;
      max-width: 220px;
      width: auto;
      height: auto;
      object-fit: contain;
      filter: contrast(1.1);
    }
    .signature-placeholder {
      font-style: italic;
      color: #999;
      font-size: 14px;
      height: 75px;
      display: flex;
      align-items: flex-end;
      justify-content: center;
      padding-bottom: 5px;
    }
    .signature-line {
      border-top: 2px solid #333;
      margin: 0 auto 10px;
      width: 85%;
    }
    .signature-name {
      font-weight: 700;
      font-size: 16px;
      color: #111;
      margin-bottom: 4px;
    }
    .signature-title {
      font-size: 12px;
      color: #666;
      text-transform: uppercase;
      letter-spacing: 1.5px;
      font-weight: 500;
    }
    .charge-to {
      text-align: center;
      color: #999;
      font-weight: 400;
      margin-top: 20px;
      font-size: 10px;
      letter-spacing: 1px;
      text-transform: uppercase;
      padding: 8px;
      background: transparent;
      border-radius: 0;
      position: relative;
      z-index: 10;
      font-style: italic;
    }
    .footer {
      text-align: center;
      margin-top: 30px;
      padding-top: 20px;
      border-top: 1px solid #eee;
      font-size: 13px;
      color: #888;
      position: relative;
      z-index: 10;
    }
    .footer a {
      color: #d4af37;
      text-decoration: underline;
      font-weight: 700;
      cursor: pointer;
    }
    .footer a:hover {
      color: #b8962e;
    }
    .print-btn {
      position: fixed;
      top: 20px;
      right: 20px;
      padding: 12px 24px;
      background: #111;
      color: white;
      border: none;
      border-radius: 4px;
      cursor: pointer;
      font-weight: 600;
      font-size: 14px;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
      transition: all 0.2s;
      z-index: 100;
    }
    .print-btn:hover {
      background: #333;
      transform: translateY(-2px);
    }
    .valid-until {
      display: inline-block;
      padding: 6px 16px;
      background: #fdfbf7;
      border: 1px solid #d4af37;
      color: #aa8529;
      border-radius: 20px;
      font-size: 12px;
      font-weight: 700;
      letter-spacing: 1px;
      margin-top: 12px;
      text-transform: uppercase;
    }
  </style>
</head>
<body>
  <button class="print-btn no-print" onclick="window.print()">Print / Save as PDF</button>
  
  <div class="voucher-container">
    <div class="header">
      <img src="${rtgLogoUrl}" alt="RTG Logo" class="logo" onerror="this.style.display='none';">
      <div class="voucher-details">
        <div class="voucher-number">${voucherNumber}</div>
        <div class="issue-date">Issued: ${formatDate(approvalDate)}</div>
        <div class="valid-until">Valid Until: ${formatDate(expiryDate)}</div>
      </div>
    </div>

    <h1 class="main-title">Complimentary Voucher</h1>

    ${showNameOnVoucher && guestNames ? `
    <div class="guest-section">
      ${isExternalGuest ? `
        <div class="guest-label">Presented To</div>
        <div class="guest-name">${guestNames}</div>
      ` : (guestTitle || guestFirstName) ? `
        <div class="guest-label">Dear ${guestTitle} ${guestFirstName}</div>
        ${guestNames && guestNames !== `${guestTitle} ${guestFirstName}`.trim() ? `<div class="guest-name" style="font-size: 20px; margin-top: 5px;">${guestNames}</div>` : ''}
      ` : `
        <div class="guest-label">Presented To</div>
        <div class="guest-name">${guestNames}</div>
      `}
    </div>
    ` : ''}

    <div class="congratulations">CONGRATULATIONS!</div>

    <div class="entitlement-box">
      ${generateEntitlementText()}
      ${specialArrangements !== 'N/A' && specialArrangements !== '' ? `<br><span style="font-size: 14px; color: #666; margin-top: 8px; display: inline-block;">Special Arrangements: ${specialArrangements}</span>` : ''}
    </div>

    <div class="terms-section">
      <div class="terms-title">Terms & Conditions</div>
      <ul class="terms-list">
        <li>This voucher is valid for 3 months from the date of issue.</li>
        <li class="expired-warning">· It cannot be extended once expired.</li>
        <li>This voucher cannot be redeemed for cash and is not transferrable.</li>
        <li>It can only be redeemed during off-peak periods, subject to availability.</li>
        <li>Confirmation of this voucher booking is subject to availability.</li>
        <li>Maximum room occupancy is strictly two people.</li>
      </ul>
    </div>

    <div class="signatures-container">
      <div class="signature-block">
        <div class="signature-image-container">
          ${commercialDirectorSignature 
            ? `<img src="${commercialDirectorSignature}" alt="${commercialDirectorName} Signature" />` 
            : `<div class="signature-placeholder">Awaiting Signature</div>`}
        </div>
        <div class="signature-line"></div>
        <div class="signature-name">${commercialDirectorName}</div>
        <div class="signature-title">${commercialDirectorTitle}</div>
      </div>
      <div class="signature-block">
        <div class="signature-image-container">
          ${ceoSignature 
            ? `<img src="${ceoSignature}" alt="${ceoName} Signature" />` 
            : `<div class="signature-placeholder">Awaiting Signature</div>`}
        </div>
        <div class="signature-line"></div>
        <div class="signature-name">${ceoName}</div>
        <div class="signature-title">Chief Executive Officer</div>
      </div>
    </div>

    <div class="charge-to">
      CHARGE TO: ${allocationType}
    </div>

    <div class="footer">
      May you kindly make your reservation through our Central Reservations Office on <strong>${contactDetails.phone}</strong><br>
      Email: <strong>${contactDetails.email}</strong><br><br>
      <em>We look forward to hosting you soon.</em>
    </div>
  </div>
</body>
</html>
  `;
}

