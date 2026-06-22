// Carrier detection and tracking URL generation

function detectCarrier(trackingNumber) {
  if (!trackingNumber) return 'Unknown';
  const tn = trackingNumber.trim().toUpperCase();

  // UPS: starts with "1Z" followed by 16 alphanumeric characters
  if (/^1Z[A-Z0-9]{16}$/i.test(tn)) return 'UPS';

  // USPS: starts with "94" and is 20-22 digits
  if (/^94\d{18,20}$/.test(tn)) return 'USPS';
  // USPS international inbound
  if (/^[A-Z]{2}\d{9}US$/i.test(tn)) return 'USPS';
  // USPS 13-character format
  if (/^\d{4}\s?\d{4}\s?\d{4}\s?\d{4}\s?\d{4}\s?\d{2}$/.test(tn.replace(/\s/g, ''))) return 'USPS';

  // FedEx: 12, 15, or 20-22 digit number
  if (/^\d{12}$/.test(tn) || /^\d{15}$/.test(tn) || /^\d{20,22}$/.test(tn)) return 'FedEx';

  return 'Unknown';
}

function getTrackingUrl(carrier, trackingNumber) {
  if (!trackingNumber) return null;
  const tn = trackingNumber.trim();

  switch (carrier) {
    case 'UPS':
      return 'https://www.ups.com/track?tracknum=' + encodeURIComponent(tn);
    case 'FedEx':
      return 'https://www.fedex.com/fedextrack/?trknbr=' + encodeURIComponent(tn);
    case 'USPS':
      return 'https://tools.usps.com/go/TrackConfirmAction?tLabels=' + encodeURIComponent(tn);
    default:
      // For unknown carriers, try a generic Google search
      return 'https://www.google.com/search?q=track+' + encodeURIComponent(tn);
  }
}
