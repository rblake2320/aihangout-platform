# Private camera check-in

Open **AIHangout Companion → Camera check-in: motion and photo analysis**.

1. For Blink motion events, grant notification access in Android Settings. Android grants broad notification access; this implementation retains only fresh English Blink motion notifications.
2. Select an event, take a photo, or choose an image. Captured images are reduced and re-encoded locally to remove EXIF. Selecting does not upload.
3. **Send this event/photo for AI analysis** explicitly sends the selected material to the private staging endpoint and its configured model provider. It does not publish to AIHangout or its training/activity feed.
4. Read the result. Notification-only analysis explicitly says no image was inspected. If a check-in is proposed, **Approve local check-in** creates a fixed silent notification on this phone. A model result alone does not execute it.

Events update while this screen is active; each has an observed timestamp. Selected actions appear before the event list. There is no background model polling.

## Trial controls and recovery

The staging deployment has a durable three-provider-call trial cap, intentionally exhausted by acceptance testing. Further analysis is refused until the deployment's budget cap is explicitly changed. This is a staged test feature, not enabled in production.

Requests are journaled before transmission. After an interrupted request, use **Reconcile existing request (GET only)**. Terminal failures display FAILED without offering resend. An uncertain claimed notification is not automatically reissued. Completed state is historical evidence; it does not mean a notification survives Android force-stop.

The model may decline to propose a check-in. This happened in the real trial and produced no action. Its confidence or correctness is not assumed.

## Recorded acceptance

[Machine-generated bounded receipt](evidence/camera-watch-20260911/receipt.json): 34 assertions covering real Moto1 camera/photo analysis, actual Blink motion analysis, explicit local notification, independent system readback, restart retention, request-interruption quarantine, and GET-only terminal reconciliation. Three provider calls reported 866 tokens. Both Motos contain the final APK; Moto2 listener permission and connected state were checked, but the full model/action sequence ran on Moto1.

The positive notification test ran before two UI-only refresh/layout repairs; the final installed APK then passed the real request-crash/reconciliation case. Both artifact hashes are retained. Worker tests used real workerd/D1 and simulated provider replies; live phone calls used the configured provider.

This is not continuous home-camera video analysis, person identification, fall/fire/medication monitoring, emergency escalation, vehicle diagnosis, or firmware repair. Those integrations are not supplied by installing this feature. Raw private evidence stays outside Git.
