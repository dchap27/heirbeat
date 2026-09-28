export function HomePage({ hasVault, onOpen, onCreate }: { hasVault: boolean; onOpen: () => void; onCreate: () => void }) {
  if (hasVault) return <section className="home-return-card">
    <div className="section-kicker">Your dashboard</div><h1>Vault state, clearly.</h1>
    <p className="body-copy">Open a vault by its Account ID to review the current on-chain inheritance policy and lifecycle.</p>
    <button className="button button-primary" onClick={onOpen}>Open a vault</button>
  </section>;

  return <div className="landing-page">
    <section className="hero">
      <div className="hero-copy">
        <span className="hero-eyebrow"><span className="hero-mark" aria-hidden="true">H</span> Digital inheritance on Miden</span>
        <h1>Your digital inheritance,<br /><em>enforced on-chain.</em></h1>
        <p className="hero-description">Set a check-in rhythm for the assets you want to pass on. If the owner becomes inactive, the named beneficiary can claim under rules locked in the vault.</p>
        <div className="hero-actions"><button className="button button-primary" onClick={onOpen}>Open existing vault <span aria-hidden="true">→</span></button><button className="button button-secondary" onClick={onCreate}>Create vault</button></div>
        <p className="hero-footnote">Vaults are opened using their Account ID. Automatic vault discovery is not available.</p>
      </div>
      <div className="hero-visual" aria-hidden="true">
        <div className="orbit orbit-outer" /><div className="orbit orbit-inner" />
        <div className="vault-glyph"><span className="vault-glyph-core">H</span><span className="glyph-ring ring-one" /><span className="glyph-ring ring-two" /></div>
        <div className="visual-label visual-label-top"><span className="visual-dot" /> Owner check-in</div>
        <div className="visual-label visual-label-bottom"><span className="visual-dot visual-dot-light" /> Beneficiary claim</div>
      </div>
    </section>
    <section className="principles-section" aria-label="How Heirbeat works">
      <div className="principle"><span className="principle-number">01</span><h2>Check in</h2><p>The owner periodically confirms the vault is active. Deposits do not reset this timer.</p></div>
      <div className="principle"><span className="principle-number">02</span><h2>Policy locks</h2><p>After finalization, beneficiary, inherited asset and timeout cannot be changed.</p></div>
      <div className="principle"><span className="principle-number">03</span><h2>Claim after inactivity</h2><p>When the block-based deadline passes, the beneficiary can claim the vault balance.</p></div>
    </section>
    <aside className="chain-note"><span className="chain-note-icon" aria-hidden="true">◇</span><p><strong>Rules are enforced by the Miden Network Account.</strong> The interface displays chain state; it is not the security boundary.</p></aside>
  </div>;
}

export function CreateVaultPlaceholder({ onBack }: { onBack: () => void }) {
  return <section className="open-card placeholder-page">
    <div className="section-kicker">Vault setup</div><h1>Create a vault</h1>
    <p className="body-copy">Vault creation and deployment are not available in this interface yet.</p>
    <p className="placeholder-note">No wallet request or transaction will be created here. When setup is available, you will review the owner, beneficiary, inherited asset and timeout before finalizing.</p>
    <button className="button button-secondary" onClick={onBack}>Back to home</button>
  </section>;
}
