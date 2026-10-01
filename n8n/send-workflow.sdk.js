import { workflow, node, trigger, ifElse, expr } from '@n8n/workflow-sdk';

const WA_CREDENTIAL = { whatsAppApi: { id: 'nSIYGJ5ZnCM2vzdD', name: 'WhatsApp account' } };
const PHONE_NUMBER_ID = '1349374634922231';

const dashboardReply = trigger({
  type: 'n8n-nodes-base.webhook',
  version: 2.1,
  config: {
    name: 'Dashboard reply',
    parameters: { httpMethod: 'POST', path: 'ikris-chat-send', responseMode: 'responseNode', options: {} }
  },
  output: [{ headers: { 'x-ikris-secret': 'secret' }, body: { to: '918448645084', text: 'Hello', media_url: '', media_type: '', file_name: '' } }]
});

const secretOk = ifElse({
  version: 2.2,
  config: {
    name: 'Secret OK?',
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'loose' },
        conditions: [{
          leftValue: expr("{{ $json.headers['x-ikris-secret'] }}"),
          operator: { type: 'string', operation: 'equals' },
          rightValue: 'REPLACE_WITH_IKRIS_SECRET'
        }],
        combinator: 'and'
      }
    }
  },
  output: [{ headers: { 'x-ikris-secret': 'secret' }, body: { to: '918448645084', text: 'Hello', media_url: '' } }]
});

const hasAttachment = ifElse({
  version: 2.2,
  config: {
    name: 'Has attachment?',
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'loose' },
        conditions: [{
          leftValue: expr('{{ $json.body.media_url }}'),
          operator: { type: 'string', operation: 'notEmpty', singleValue: true }
        }],
        combinator: 'and'
      }
    }
  },
  output: [{ headers: {}, body: { to: '918448645084', text: 'Hello', media_url: 'https://example.com/a.pdf', media_type: 'application/pdf', file_name: 'a.pdf' } }]
});

const sendText = node({
  type: 'n8n-nodes-base.whatsApp',
  version: 1.1,
  config: {
    name: 'Send text',
    onError: 'continueErrorOutput',
    parameters: {
      resource: 'message',
      operation: 'send',
      phoneNumberId: PHONE_NUMBER_ID,
      recipientPhoneNumber: expr('{{ $json.body.to }}'),
      messageType: 'text',
      textBody: expr('{{ $json.body.text }}'),
      additionalFields: {}
    },
    credentials: WA_CREDENTIAL
  },
  output: [{ messaging_product: 'whatsapp', messages: [{ id: 'wamid.ABC' }] }]
});

const sendFile = node({
  type: 'n8n-nodes-base.whatsApp',
  version: 1.1,
  config: {
    name: 'Send file',
    onError: 'continueErrorOutput',
    parameters: {
      resource: 'message',
      operation: 'send',
      phoneNumberId: PHONE_NUMBER_ID,
      recipientPhoneNumber: expr('{{ $json.body.to }}'),
      messageType: 'document',
      mediaPath: 'useMediaLink',
      mediaLink: expr('{{ $json.body.media_url }}'),
      additionalFields: {
        mediaCaption: expr("{{ $json.body.text || '' }}"),
        mediaFilename: expr("{{ $json.body.file_name || 'attachment' }}")
      }
    },
    credentials: WA_CREDENTIAL
  },
  output: [{ messaging_product: 'whatsapp', messages: [{ id: 'wamid.DEF' }] }]
});

const replySent = node({
  type: 'n8n-nodes-base.respondToWebhook',
  version: 1.1,
  config: {
    name: 'Reply: sent',
    parameters: {
      respondWith: 'json',
      responseBody: expr("{{ JSON.stringify({ ok: true, wa_message_id: ($json.messages && $json.messages[0] && $json.messages[0].id) || '' }) }}"),
      options: {}
    }
  },
  output: [{ ok: true }]
});

const replyFailed = node({
  type: 'n8n-nodes-base.respondToWebhook',
  version: 1.1,
  config: {
    name: 'Reply: failed',
    parameters: {
      respondWith: 'json',
      responseBody: expr("{{ JSON.stringify({ ok: false, error: String(($json.error && ($json.error.message || $json.error.description || $json.error)) || 'WhatsApp rejected the message') }) }}"),
      options: { responseCode: 502 }
    }
  },
  output: [{ ok: false }]
});

const replyUnauthorized = node({
  type: 'n8n-nodes-base.respondToWebhook',
  version: 1.1,
  config: {
    name: 'Reply: unauthorized',
    parameters: {
      respondWith: 'json',
      responseBody: '{ "ok": false, "error": "unauthorized" }',
      options: { responseCode: 401 }
    }
  },
  output: [{ ok: false }]
});

export default workflow('ikris-dashboard-send', 'Ikris Dashboard – Send WhatsApp reply')
  .add(dashboardReply)
  .to(secretOk
    .onTrue(hasAttachment
      .onTrue(sendFile.onError(replyFailed).to(replySent))
      .onFalse(sendText.onError(replyFailed).to(replySent)))
    .onFalse(replyUnauthorized));
