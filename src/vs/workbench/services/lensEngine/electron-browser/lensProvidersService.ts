import { ILensProvidersService } from '../../../../platform/lensEngine/common/lensProviders.js';
import { registerMainProcessRemoteService } from '../../../../platform/ipc/electron-browser/services.js';

registerMainProcessRemoteService(ILensProvidersService, 'lensProviders');
