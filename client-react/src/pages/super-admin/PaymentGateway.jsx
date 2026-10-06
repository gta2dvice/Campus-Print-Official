import { useEffect, useState } from 'react';
import { saApi, Loading, ErrorState } from './shared';

export default function PaymentGateway() {
  const [gateway, setGateway] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    (async () => {
      try {
        const res = await saApi('/api/super-admin/payment-gateway');
        if (!res.ok) throw new Error('Failed to load gateway status');
        setGateway(await res.json());
      } catch (err) {
        setError(err.message);
      }
    })();
  }, []);

  return (
    <div className="max-w-[560px] rounded-[18px] border border-gray-300/50 bg-white/90 p-6 max-sm:p-4 shadow-sm backdrop-blur-md">
      <h2 className="mb-[1.1rem] text-base font-bold text-gray-900">Gateway Status</h2>
      {error ? (
        <ErrorState>Couldn't load gateway status. {error}</ErrorState>
      ) : !gateway ? (
        <Loading />
      ) : (
        <>
          <div className="flex items-center gap-4 rounded-[14px] bg-black/[0.02] p-5">
            <div className={`h-3 w-3 flex-shrink-0 rounded-full ${gateway.status === 'connected' ? 'bg-emerald-500 shadow-[0_0_0_4px_rgba(16,185,129,0.15)]' : 'bg-gray-400 shadow-[0_0_0_4px_rgba(156,163,175,0.15)]'}`} />
            <div>
              <div className="font-bold text-gray-900">{gateway.provider}</div>
              <div className="mt-[0.15rem] text-[0.82rem] text-gray-600">
                {gateway.status === 'connected' ? `Connected · ${gateway.mode === 'production' ? 'Live mode' : 'Test mode'}` : 'Not connected'}
              </div>
            </div>
          </div>
          <div className="flex items-center justify-between border-t border-[#f0f4f8] py-[0.65rem] text-[0.85rem]">
            <span className="text-gray-600">Webhook Configured</span>
            <span className="font-bold text-gray-900">{gateway.webhookConfigured ? 'Yes' : 'No'}</span>
          </div>
          <p className="mt-4 text-[0.8rem] text-gray-400">
            {gateway.status === 'connected'
              ? 'Gateway credentials are configured on the server and never exposed to the browser.'
              : 'No live payment gateway is configured yet. Orders can still be recorded via the sandbox simulate path until Cashfree keys are set on the server.'}
          </p>
        </>
      )}
    </div>
  );
}
