import { describe, expect, it } from 'vitest';
import { companionTools, KNOWN_TOOLS } from '../../server/agents/tools/index.js';

describe('companionTools', () => {
  it('gives crm_report to agents that can search the CRM', () => {
    expect(companionTools(['search_crm', 'read_file'])).toEqual(['search_crm', 'read_file', 'crm_report']);
  });
  it('gives crm_report to the coordinator', () => {
    expect(companionTools(['delegate_to_specialists'], { coordinator: true })).toContain('crm_report');
  });
  it('does not grant it when CRM search was removed, and never duplicates it', () => {
    expect(companionTools(['read_file'])).toEqual(['read_file']);
    expect(companionTools(['search_crm', 'crm_report'])).toEqual(['search_crm', 'crm_report']);
  });
  it('is a known, implemented tool', () => {
    expect(KNOWN_TOOLS).toContain('crm_report');
  });
  it('gives read-only GitHub tools to the coordinator and workspace-reading agents only', () => {
    expect(companionTools(['delegate_to_specialists'], { coordinator: true })).toEqual(expect.arrayContaining(['list_github_repos', 'read_github_repo']));
    expect(companionTools(['search_workspace'])).toEqual(['search_workspace', 'list_github_repos', 'read_github_repo']);
    expect(companionTools(['read_file'])).not.toContain('list_github_repos');
    expect(KNOWN_TOOLS).toEqual(expect.arrayContaining(['list_github_repos', 'read_github_repo']));
  });
});
