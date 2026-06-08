// Pre-Token Generation Lambda (v2 trigger).
//
// Cognito V2_0 trigger event shape: the user's group memberships arrive in
// `event.request.groupConfiguration.groupsToOverride` (string[]). We pick the
// first matching department group and inject `dept` + `dept_source` claims
// into BOTH access and ID tokens.
//
// Cheat sheet locks v2 because v1 cannot mutate the access token claim set.

const DEPT_GROUPS = ['hr', 'sales', 'eng', 'fin'] as const;
type Dept = (typeof DEPT_GROUPS)[number] | 'guest';

interface PreTokenV2Event {
  request: {
    groupConfiguration?: {
      groupsToOverride?: string[];
    };
  };
  response: unknown;
}

export const handler = async (event: PreTokenV2Event): Promise<PreTokenV2Event> => {
  const groups = event.request.groupConfiguration?.groupsToOverride ?? [];
  const dept: Dept = (DEPT_GROUPS.find((d) => groups.includes(d)) as Dept) ?? 'guest';

  const claims = { dept, dept_source: 'cognito-group' };

  event.response = {
    claimsAndScopeOverrideDetails: {
      accessTokenGeneration: { claimsToAddOrOverride: claims },
      idTokenGeneration: { claimsToAddOrOverride: claims },
    },
  };

  return event;
};
