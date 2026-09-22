import { ILensLiteLlmConfigService } from '../../../../platform/lensEngine/common/lensLiteLlmConfig.js';
import { registerMainProcessRemoteService } from '../../../../platform/ipc/electron-browser/services.js';

registerMainProcessRemoteService(ILensLiteLlmConfigService, 'lensLiteLlmConfig');
