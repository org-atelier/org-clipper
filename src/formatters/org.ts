import { OutputFormatter, OutputFormat } from './types';
import { Property } from '../types/types';

/**
 * Org-mode formatter — converts content to Org syntax
 * and metadata to property drawer format.
 *
 * Property drawer format:
 *   :PROPERTIES:
 *   :key: value
 *   :END:
 */
export const orgFormatter: OutputFormatter = {
  fileExtension: 'org',
  format: 'org' as OutputFormat,

  formatContent(html: string, url: string): string {
    // Will be implemented when html-to-org is integrated
    // For now, return HTML as-is (degraded mode)
    try {
      // Lazy import to avoid hard dependency during initial setup
      const { htmlToOrg } = require('html-to-org');
      return htmlToOrg(html, url);
    } catch {
      return html;
    }
  },

  formatMeta(properties: Property[], propertyTypes: Record<string, string>): string {
    return generatePropertyDrawer(properties, propertyTypes);
  },
};

/**
 * Generate Org-mode property drawer from compiled properties.
 *
 *   :PROPERTIES:
 *   :title: Some Value
 *   :END:
 */
function generatePropertyDrawer(
  properties: Property[],
  propertyTypes: Record<string, string> = {}
): string {
  if (properties.length === 0) return '';

  let drawer = ':PROPERTIES:\n';

  for (const property of properties) {
    const name = property.name.trim();
    const propertyType = propertyTypes[property.name] || 'text';
    const value = formatOrgPropertyValue(property.value, propertyType);

    drawer += `:${name}:`;
    if (value) {
      drawer += ` ${value}`;
    }
    drawer += '\n';
  }

  drawer += ':END:\n';
  return drawer;
}

/**
 * Format a property value for the org property drawer.
 * Sanitizes newlines and :END: markers to prevent drawer corruption.
 */
function formatOrgPropertyValue(value: string, type: string): string {
  if (!value || value.trim() === '') return '';

  // Sanitize: replace newlines with spaces, escape :END: to prevent drawer break
  let sanitized = value.replace(/\n/g, ' ').replace(/:END:/gi, ':END\\:');

  switch (type) {
    case 'multitext': {
      let items: string[];
      if (sanitized.trim().startsWith('["') && sanitized.trim().endsWith('"]')) {
        try {
          items = JSON.parse(sanitized);
        } catch {
          items = sanitized.split(',').map(item => item.trim());
        }
      } else {
        items = sanitized.split(/,(?![^\[]*\]\])/).map(item => item.trim());
      }
      items = items.filter(item => item !== '');
      return items.join(' ');
    }
    case 'number': {
      const numericValue = sanitized.replace(/[^\d.-]/g, '');
      return numericValue ? parseFloat(numericValue).toString() : '';
    }
    case 'checkbox': {
      const isChecked = sanitized === 'true' || sanitized === '1';
      return isChecked ? 't' : 'nil';
    }
    case 'date':
    case 'datetime':
      return sanitized.trim();
    default:
      return sanitized.trim();
  }
}
