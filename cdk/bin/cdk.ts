#!/usr/bin/env node
import "source-map-support/register";
import * as cdk from "@aws-cdk/core";
import { CdkStack } from "../lib/cdk-stack";
import { env } from "process";

const app = new cdk.App();
new CdkStack(
  app,
  "CdkStack",
  {
    albCertArn: env.ALB_CERT_ARN!,
    dbName: "wordpress",
    dbUser: "wordpress",
    amiName: "wordpress",
  },
  {
    env: {
      account: process.env.CDK_DEFAULT_ACCOUNT,
      region: process.env.CDK_DEFAULT_REGION,
    },
  }
);
