// Pure shared Node/browser validation. Policies travel with pinned public roots,
// never with untrusted release metadata downloaded from a server.
export function validateReleaseTrust(keyId,policies,manifest,strict=true,now=Date.now()) {
  const policy=policies?.[keyId];
  if(!policy) {if(strict)throw Error('Signing root validity policy missing');return;}
  const start=Date.parse(policy.notBefore),end=Date.parse(policy.notAfter);
  if(policy.revoked===true||!Number.isFinite(start)||!Number.isFinite(end)||end<=start||now<start||now>=end)throw Error('Signing root revoked or outside validity window');
  if(manifest) {
    const issued=Date.parse(manifest.createdAt),expires=Date.parse(manifest.expiresAt);
    if(!Number.isFinite(issued)||!Number.isFinite(expires)||issued<start||issued>now+300000||expires<=issued||expires>end)throw Error('Release lifetime exceeds pinned signing policy');
  }
}
