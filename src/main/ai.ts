import type { Device } from './types';
import type { ProviderId } from './settings';

type SummaryInput = {
  device: Device;
  totalDevices: number;
  onlineDevices: number;
  detectedAt: number;
};

type AiSummary = {
  provider: ProviderId;
  model: string;
  text: string;
};

type ProviderResult = {
  text: string;
  model: string;
};

type ProviderConfig = {
  openai: { model: string };
  gemini: { model: string };
  claude: { model: string };
};

const defaultConfig: ProviderConfig = {
  openai: { model: 'gpt-4.1-mini' },
  gemini: { model: 'gemini-2.5-flash' },
  claude: { model: 'claude-sonnet-4-20250514' },
};

const timeoutFetch = async (url: string, options: RequestInit, timeoutMs = 12000) => {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    return response;
  } finally {
    clearTimeout(id);
  }
};

const extractJsonMessage = (payload: any): string | null => {
  if (!payload || typeof payload !== 'object') return null;
  if (payload.error) {
    if (typeof payload.error === 'string') return payload.error;
    if (typeof payload.error.message === 'string') return payload.error.message;
  }
  if (typeof payload.message === 'string') return payload.message;
  if (payload.error && typeof payload.error === 'object' && typeof payload.error.msg === 'string') {
    return payload.error.msg;
  }
  return null;
};

const formatDeviceContext = ({ device, totalDevices, onlineDevices, detectedAt }: SummaryInput) => {
  const hostname = device.hostname ?? 'Unknown';
  const vendor = device.vendor ?? 'Unknown';
  const ip = device.ip;
  const mac = device.mac ?? 'Unknown';
  const time = new Date(detectedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return `New device detected.\nTime: ${time}\nIP: ${ip}\nMAC: ${mac}\nHostname: ${hostname}\nVendor: ${vendor}\nOnline devices: ${onlineDevices}\nTotal devices: ${totalDevices}`;
};

const openAiSummary = async (apiKey: string, input: SummaryInput, config: ProviderConfig['openai']): Promise<ProviderResult> => {
  const body = {
    model: config.model,
    messages: [
      {
        role: 'system',
        content:
          'You are the AnetI network monitor. Provide a concise 2-3 sentence summary of a newly detected device. ' +
          'Be clear, non-alarmist, and suggest a simple next step if needed. Use plain language.',
      },
      {
        role: 'user',
        content: formatDeviceContext(input),
      },
    ],
    temperature: 0.3,
    max_tokens: 160,
  };

  const response = await timeoutFetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    let message = text;
    try {
      const parsed = JSON.parse(text);
      message = extractJsonMessage(parsed) ?? text;
    } catch {
      // ignore
    }
    throw new Error(message);
  }

  const data = await response.json();
  const text = data?.choices?.[0]?.message?.content;
  if (!text) throw new Error('OpenAI returned an empty response.');
  return { text: String(text).trim(), model: data?.model ?? config.model };
};

const geminiSummary = async (apiKey: string, input: SummaryInput, config: ProviderConfig['gemini']): Promise<ProviderResult> => {
  const body = {
    contents: [
      {
        parts: [
          {
            text:
              'You are the AnetI network monitor. Provide a concise 2-3 sentence summary of a newly detected device. ' +
              'Be clear, non-alarmist, and suggest a simple next step if needed. Use plain language.\n\n' +
              formatDeviceContext(input),
          },
        ],
      },
    ],
  };

  const response = await timeoutFetch(`https://generativelanguage.googleapis.com/v1beta/models/${config.model}:generateContent`, {
    method: 'POST',
    headers: {
      'x-goog-api-key': apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    let message = text;
    try {
      const parsed = JSON.parse(text);
      message = extractJsonMessage(parsed) ?? text;
    } catch {
      // ignore
    }
    throw new Error(message);
  }

  const data = await response.json();
  const text = data?.candidates?.[0]?.content?.parts?.map((part: any) => part?.text).filter(Boolean).join(' ');
  if (!text) throw new Error('Gemini returned an empty response.');
  return { text: String(text).trim(), model: config.model };
};

const claudeSummary = async (apiKey: string, input: SummaryInput, config: ProviderConfig['claude']): Promise<ProviderResult> => {
  const body = {
    model: config.model,
    max_tokens: 200,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text:
              'You are the AnetI network monitor. Provide a concise 2-3 sentence summary of a newly detected device. ' +
              'Be clear, non-alarmist, and suggest a simple next step if needed. Use plain language.\n\n' +
              formatDeviceContext(input),
          },
        ],
      },
    ],
  };

  const response = await timeoutFetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    let message = text;
    try {
      const parsed = JSON.parse(text);
      message = extractJsonMessage(parsed) ?? text;
    } catch {
      // ignore
    }
    throw new Error(message);
  }

  const data = await response.json();
  const text = data?.content?.map((part: any) => part?.text).filter(Boolean).join(' ');
  if (!text) throw new Error('Claude returned an empty response.');
  return { text: String(text).trim(), model: config.model };
};

const sanitizeSummary = (value: string) => value.replace(/\s+/g, ' ').trim().slice(0, 600);

export const createAiClient = (
  getKey: (provider: ProviderId) => string | undefined,
  config: ProviderConfig = defaultConfig
) => {
  const providerOrder: ProviderId[] = ['openai', 'gemini', 'claude'];

  const selectProvider = (): ProviderId | null => {
    for (const provider of providerOrder) {
      const key = getKey(provider);
      if (key && key.trim()) return provider;
    }
    return null;
  };

  const summarizeNewDevice = async (input: SummaryInput): Promise<AiSummary | null> => {
    const provider = selectProvider();
    if (!provider) return null;
    const apiKey = getKey(provider);
    if (!apiKey) return null;

    try {
      let result: ProviderResult;
      if (provider === 'openai') {
        result = await openAiSummary(apiKey, input, config.openai);
      } else if (provider === 'gemini') {
        result = await geminiSummary(apiKey, input, config.gemini);
      } else {
        result = await claudeSummary(apiKey, input, config.claude);
      }

      return {
        provider,
        model: result.model,
        text: sanitizeSummary(result.text),
      };
    } catch (error) {
      console.warn(`[ai] ${provider} summary failed`, error);
      return null;
    }
  };

  return {
    summarizeNewDevice,
  };
};
