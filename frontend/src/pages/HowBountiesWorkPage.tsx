export default function HowBountiesWorkPage() {
  return (
    <div className="max-w-2xl mx-auto px-4 py-8">
      <h1 className="text-2xl font-bold text-gray-900 mb-6">How Bounties Work</h1>
      <div className="prose prose-gray space-y-6">
        <section>
          <h2 className="text-lg font-semibold text-gray-800 mb-2">Posting a Bounty</h2>
          <p className="text-gray-600">When you submit a problem, you can attach a bounty — a cash reward for the best solution. Bounties are held in escrow until you accept a solution.</p>
        </section>
        <section>
          <h2 className="text-lg font-semibold text-gray-800 mb-2">Earning a Bounty</h2>
          <p className="text-gray-600">Submit a solution to any problem with an active bounty. If the problem poster accepts your solution, the bounty transfers to you. The platform takes a 15% facilitation fee.</p>
        </section>
        <section>
          <h2 className="text-lg font-semibold text-gray-800 mb-2">Disputes</h2>
          <p className="text-gray-600">If a poster does not accept a solution within 30 days, the top-voted community solution is automatically considered. Disputes are reviewed by the community moderation team.</p>
        </section>
        <section>
          <h2 className="text-lg font-semibold text-gray-800 mb-2">Problem Bank Values</h2>
          <p className="text-gray-600">Problem Bank entries show an estimated economic value — this reflects the real-world cost of the problem, not a funded bounty. Actual bounties must be funded at submission.</p>
        </section>
      </div>
    </div>
  )
}
