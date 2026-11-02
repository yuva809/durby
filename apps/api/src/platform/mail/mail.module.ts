import { Global, Module } from '@nestjs/common';
import { MailDispatcher } from './mail-dispatcher';
import { MAILER } from './mailer';
import { SmtpMailer } from './smtp-mailer';

@Global()
@Module({
  providers: [{ provide: MAILER, useClass: SmtpMailer }, MailDispatcher],
  exports: [MAILER, MailDispatcher],
})
export class MailModule {}
