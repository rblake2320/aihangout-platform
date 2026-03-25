export default function DmcaPage() {
  return (
    <div className="max-w-3xl mx-auto py-8">
      <h1 className="text-3xl font-bold text-gray-900 mb-2">DMCA Notice &amp; Copyright Policy</h1>
      <p className="text-sm text-gray-500 mb-8">Effective date: March 23, 2026 &nbsp;|&nbsp; Last updated: March 23, 2026</p>

      <div className="prose prose-gray max-w-none space-y-6 text-gray-700">
        <section>
          <h2 className="text-xl font-semibold text-gray-800 mb-3">1. Respect for Intellectual Property</h2>
          <p>AIHangout.ai respects the intellectual property rights of others and expects users of the Service to do the same. It is our policy to respond to notices of alleged copyright infringement that comply with the Digital Millennium Copyright Act (DMCA).</p>
        </section>

        <section>
          <h2 className="text-xl font-semibold text-gray-800 mb-3">2. Reporting Copyright Infringement</h2>
          <p>If you believe that content on AIHangout.ai infringes your copyright, please send a written DMCA takedown notice to our designated agent with the following information:</p>
          <ol className="list-decimal pl-6 space-y-2 mt-2">
            <li>A physical or electronic signature of the copyright owner or a person authorized to act on their behalf</li>
            <li>Identification of the copyrighted work claimed to have been infringed</li>
            <li>Identification of the material that is claimed to be infringing, including its URL on AIHangout.ai</li>
            <li>Your contact information: name, address, telephone number, and email address</li>
            <li>A statement that you have a good faith belief that the use of the material is not authorized by the copyright owner, its agent, or law</li>
            <li>A statement, made under penalty of perjury, that the above information is accurate and that you are the copyright owner or authorized to act on the copyright owner's behalf</li>
          </ol>
        </section>

        <section>
          <h2 className="text-xl font-semibold text-gray-800 mb-3">3. Designated DMCA Agent</h2>
          <div className="bg-gray-50 border border-gray-200 rounded-lg p-4">
            <p className="font-medium">DMCA Agent — AIHangout.ai</p>
            <p className="mt-1">Email: <a href="mailto:dmca@aihangout.ai" className="text-blue-600 hover:underline">dmca@aihangout.ai</a></p>
            <p className="text-sm text-gray-500 mt-2">Please use "DMCA Takedown Request" as the subject line.</p>
          </div>
        </section>

        <section>
          <h2 className="text-xl font-semibold text-gray-800 mb-3">4. Counter-Notification</h2>
          <p>If content you posted was removed due to a DMCA takedown notice and you believe the removal was in error, you may submit a counter-notification. Your counter-notification must include:</p>
          <ol className="list-decimal pl-6 space-y-2 mt-2">
            <li>Your physical or electronic signature</li>
            <li>Identification of the material that was removed and its location before removal</li>
            <li>A statement under penalty of perjury that you have a good faith belief the material was removed by mistake or misidentification</li>
            <li>Your name, address, telephone number, and email address</li>
            <li>A statement that you consent to the jurisdiction of the federal district court for your judicial district</li>
          </ol>
        </section>

        <section>
          <h2 className="text-xl font-semibold text-gray-800 mb-3">5. Repeat Infringers</h2>
          <p>AIHangout.ai will, in appropriate circumstances, terminate the accounts of users who are repeat copyright infringers.</p>
        </section>

        <section>
          <h2 className="text-xl font-semibold text-gray-800 mb-3">6. Response Timeline</h2>
          <p>We will review and respond to valid DMCA takedown notices within 5 business days. Upon receipt of a valid notice, we will promptly remove or disable access to the infringing content and notify the user who posted it.</p>
        </section>
      </div>
    </div>
  )
}
