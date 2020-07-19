import * as cdk from "@aws-cdk/core";
import * as elbv2 from "@aws-cdk/aws-elasticloadbalancingv2";
import * as asg from "@aws-cdk/aws-autoscaling";
import * as ec2 from "@aws-cdk/aws-ec2";
import * as efs from "@aws-cdk/aws-efs";
import * as iam from "@aws-cdk/aws-iam";
import * as rds from "@aws-cdk/aws-rds";
import * as sns from "@aws-cdk/aws-sns";
import * as waf from "@aws-cdk/aws-wafv2";
import * as acm from "@aws-cdk/aws-certificatemanager";
import * as cloudwatch from "@aws-cdk/aws-cloudwatch";
import * as cwactions from "@aws-cdk/aws-cloudwatch-actions";
import * as cloudfront from "@aws-cdk/aws-cloudfront";

interface IParams {
  frontCertArn: string;
  albDomain: string;
  albCertArn: string;
  albKeyName: string;
  albKeyValue: string;
  isOnwerOnly: boolean;
  dbName: string;
  dbUser: string;
  amiName: string;
  ownerIps: string[];
}

export class CdkStack extends cdk.Stack {
  constructor(
    scope: cdk.Construct,
    id: string,
    params: IParams,
    props?: cdk.StackProps
  ) {
    super(scope, id, props);

    const {
      vpc,
      snIngress,
      snApp,
      snData,
      sgALB,
      sgApp,
      sgDB,
      sgEFS,
    } = this.createVpc();

    const topic = new sns.Topic(this, "snsAlarmTopic", {
      topicName: "infraAlarm",
    });

    const db = this.createRDS(
      vpc,
      sgDB,
      snData,
      ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MICRO),
      params.dbName,
      params.dbUser,
      10
    );
    const efs = this.createEFS(vpc, snData, sgEFS);

    // TODO: S3 for backup
    const group = this.createInstances(
      vpc,
      snApp,
      sgApp,
      params.amiName,
      ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MICRO),
      8,
      efs.fileSystemId,
      topic
    );
    this.createCloudwatchAlarms(topic, db.instanceIdentifier);

    const alb = this.createALB(vpc, sgALB, snIngress, group, params.albCertArn);
    this.createWAF(
      alb.loadBalancerArn,
      params.ownerIps,
      params.isOnwerOnly,
      params.albKeyName,
      params.albKeyValue
    );
    this.createCloudfront(
      params.frontCertArn,
      params.albDomain,
      params.albKeyName,
      params.albKeyValue
    );
  }

  createVpc(): {
    vpc: ec2.Vpc;
    snIngress: ec2.SubnetSelection;
    snApp: ec2.SubnetSelection;
    snData: ec2.SubnetSelection;
    sgALB: ec2.SecurityGroup;
    sgApp: ec2.SecurityGroup;
    sgDB: ec2.SecurityGroup;
    sgEFS: ec2.SecurityGroup;
  } {
    const vpc = new ec2.Vpc(this, "VPC", {
      cidr: "10.0.0.0/24",
      maxAzs: 2,
      subnetConfiguration: [
        {
          name: "Ingress",
          subnetType: ec2.SubnetType.PUBLIC,
        },
        {
          name: "Data",
          subnetType: ec2.SubnetType.ISOLATED,
        },
        {
          name: "App",
          subnetType: ec2.SubnetType.ISOLATED,
        },
      ],
    });

    // subnets ---
    const snIngress = vpc.selectSubnets({ subnetGroupName: "Ingress" });
    const snApp = vpc.selectSubnets({ subnetGroupName: "App" });
    const snData = vpc.selectSubnets({ subnetGroupName: "Data" });

    // security groups ---
    const sgALB = new ec2.SecurityGroup(this, "sgALB", { vpc });
    sgALB.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80));
    sgALB.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443));

    const sgApp = new ec2.SecurityGroup(this, "sgApp", { vpc });
    sgApp.addIngressRule(sgALB, ec2.Port.tcp(80));

    const sgDB = new ec2.SecurityGroup(this, "sgDB", { vpc });
    sgDB.addIngressRule(sgApp, ec2.Port.tcp(3306));

    const sgEFS = new ec2.SecurityGroup(this, "sgEFS", { vpc });
    sgEFS.addIngressRule(sgApp, ec2.Port.tcp(2049));

    // VPC endpoints ---
    Object.entries({
      // for cloudwatch agent
      vpcLogsEndpoint: ec2.InterfaceVpcEndpointAwsService.CLOUDWATCH_LOGS,
      vpcEc2Endpoint: ec2.InterfaceVpcEndpointAwsService.EC2,
      vpcMonitorEndpoint: ec2.InterfaceVpcEndpointAwsService.CLOUDWATCH,
      // for SSM SSH
      vpcEc2mEndpoint: ec2.InterfaceVpcEndpointAwsService.EC2_MESSAGES,
      vpcSsmmEndpoint: ec2.InterfaceVpcEndpointAwsService.SSM_MESSAGES,
      vpcSsmEndpoint: ec2.InterfaceVpcEndpointAwsService.SSM,
    }).forEach(([key, value]) => {
      vpc.addInterfaceEndpoint(key, {
        service: value,
        subnets: vpc.selectSubnets({ subnetGroupName: "App" }),
      });
    });
    vpc.addS3Endpoint("vpcS3Endpoint", [snApp]);

    return {
      vpc,
      snIngress,
      snApp,
      snData,
      sgALB,
      sgApp,
      sgDB,
      sgEFS,
    };
  }

  createRDS(
    vpc: ec2.Vpc,
    sg: ec2.SecurityGroup,
    subnets: ec2.SubnetSelection,
    instanceType: ec2.InstanceType,
    dbName: string,
    dbUser: string,
    storageSize: number
  ): rds.DatabaseInstance {
    const db = new rds.DatabaseInstance(this, "RDS", {
      vpc,
      vpcPlacement: subnets,
      securityGroups: [sg],
      engine: rds.DatabaseInstanceEngine.mysql({
        version: rds.MysqlEngineVersion.VER_5_7_30,
      }),
      instanceType,
      multiAz: false, // TODO: for development
      deletionProtection: false, // TODO: for development
      masterUsername: dbUser,
      databaseName: dbName,
      allocatedStorage: storageSize,
      parameterGroup: new rds.ParameterGroup(this, "rdsParamGroup", {
        engine: rds.DatabaseInstanceEngine.mysql({
          version: rds.MysqlEngineVersion.VER_5_7_30,
        }),
        parameters: {
          character_set_client: "utf8",
          character_set_connection: "utf8",
          character_set_database: "utf8",
          character_set_server: "utf8",
          collation_connection: "utf8_bin",
          collation_server: "utf8_bin",
        },
      }),
    });

    return db;
  }

  createEFS(vpc: ec2.Vpc, subnets: ec2.SubnetSelection, sg: ec2.SecurityGroup) {
    return new efs.FileSystem(this, "ContentsStorage", {
      vpc,
      vpcSubnets: subnets,
      securityGroup: sg,
      fileSystemName: "wordpress",
    });
  }

  createInstances(
    vpc: ec2.Vpc,
    vpcSubnets: ec2.SubnetSelection,
    securityGroup: ec2.SecurityGroup,
    amiName: string,
    instanceType: ec2.InstanceType,
    volumeSize: number,
    efsId: string,
    topic: sns.Topic
  ): asg.AutoScalingGroup {
    const machineImage = new ec2.LookupMachineImage({
      name: amiName,
      filters: { "owner-id": [this.account], state: ["available"] },
    });

    const role = new iam.Role(this, "IAMRoleEC2", {
      assumedBy: new iam.ServicePrincipal("ec2.amazonaws.com"),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName(
          "service-role/AmazonEC2RoleforSSM"
        ),
        iam.ManagedPolicy.fromAwsManagedPolicyName(
          "CloudWatchAgentServerPolicy"
        ),
      ],
    });

    const userData = ec2.UserData.custom(`#!/bin/bash
yum update -y --security

echo "${efsId}:/ /var/www/html efs tls,_netdev" >> /etc/fstab
mount -a -t efs defaults
`);

    const group = new asg.AutoScalingGroup(this, "AutoscalingGroup", {
      vpc,
      vpcSubnets,
      securityGroup,
      instanceType,
      role,
      allowAllOutbound: false,
      minCapacity: 2,
      maxCapacity: 4,
      machineImage,
      instanceMonitoring: asg.Monitoring.BASIC,
      notifications: [
        {
          topic,
          scalingEvents: new asg.ScalingEvents(
            asg.ScalingEvent.INSTANCE_LAUNCH
          ),
        },
      ],
      blockDevices: [
        {
          deviceName: "/dev/xvda",
          volume: {
            ebsDevice: {
              volumeSize,
              deleteOnTermination: true,
              volumeType: asg.EbsDeviceVolumeType.GP2,
            },
          },
        },
      ],
      userData,
    });
    return group;
  }

  createCloudwatchAlarms(topic: sns.Topic, dbId: string) {
    // TODO: 残りのアラーム
    // group cpu
    // group memory
    // group disk
    // db memory
    const action = new cwactions.SnsAction(topic);
    [
      new cloudwatch.Alarm(this, "alarmRdsCpu", {
        alarmName: "RDS_CPU_High",
        threshold: 80,
        evaluationPeriods: 2, // 10 minutes
        metric: new cloudwatch.Metric({
          namespace: "AWS/RDS",
          metricName: "CPUUtilization",
          dimensions: {
            DBInstanceIdentifier: dbId,
          },
        }),
      }),
    ].forEach((alarm) => {
      alarm.addAlarmAction(action);
    });
  }

  createALB(
    vpc: ec2.Vpc,
    sg: ec2.SecurityGroup,
    subnets: ec2.SubnetSelection,
    group: asg.AutoScalingGroup,
    certArn: string
  ): elbv2.ApplicationLoadBalancer {
    const alb = new elbv2.ApplicationLoadBalancer(this, "ALB", {
      vpc,
      vpcSubnets: subnets,
      internetFacing: true,
      securityGroup: sg,
    });
    alb
      .addListener("albListner80", { port: 80 })
      .addRedirectResponse("albListener80RedirectResponse", {
        protocol: "HTTPS",
        port: "443",
        statusCode: "HTTP_301",
      });
    alb
      .addListener("albListner443", {
        port: 443,
        certificateArns: [certArn],
      })
      .addTargets("albtgApp", {
        targets: [group],
        protocol: elbv2.ApplicationProtocol.HTTP,
        healthCheck: {
          path: "/",
          healthyHttpCodes: "200",
          interval: cdk.Duration.seconds(60),
          timeout: cdk.Duration.seconds(30),
        },
      });

    return alb;
  }

  createWAF(
    albArn: string,
    ownerIps: string[],
    isOwnerOnly: boolean,
    albKeyName: string,
    albKeyValue: string
  ) {
    const vcNoLogging = {
      cloudWatchMetricsEnabled: false,
      metricName: "noLogging",
      sampledRequestsEnabled: false,
    };
    const visibilityConfig = (name: string) => ({
      cloudWatchMetricsEnabled: true,
      metricName: name,
      sampledRequestsEnabled: true,
    });

    const ipSet = new waf.CfnIPSet(this, "wafIpSet", {
      addresses: ownerIps,
      ipAddressVersion: "IPV4",
      scope: "REGIONAL",
    });
    const ownerRule = new waf.CfnRuleGroup(this, "wafRuleGroupOwner", {
      name: "owner",
      capacity: 3,
      scope: "REGIONAL",
      visibilityConfig: vcNoLogging,
      rules: [
        {
          name: "allowOwners",
          priority: 0,
          action: {
            allow: {},
          },
          statement: {
            ipSetReferenceStatement: {
              arn: ipSet.attrArn,
            },
          },
          visibilityConfig: vcNoLogging,
        },
        {
          name: "denyAdmin",
          priority: 1,
          action: {
            block: {},
          },
          statement: {
            byteMatchStatement: {
              searchString: "/wp-admin",
              fieldToMatch: {
                uriPath: {},
              },
              positionalConstraint: "STARTS_WITH",
              textTransformations: [
                {
                  priority: 0,
                  type: "NONE",
                },
              ],
            },
          },
          visibilityConfig: vcNoLogging,
        },
      ],
    });

    const ownerOnlyRule = new waf.CfnRuleGroup(this, "wafRuleGroupOwnerOnly", {
      name: "ownerOnly",
      capacity: 1,
      scope: "REGIONAL",
      visibilityConfig: vcNoLogging,
      rules: [
        {
          name: "denyNotOwners",
          priority: 0,
          action: {
            block: {},
          },
          statement: {
            notStatement: {
              statement: {
                ipSetReferenceStatement: {
                  arn: ipSet.attrArn,
                },
              },
            },
          },
          visibilityConfig: vcNoLogging,
        },
      ],
    });

    const cdnOnlyRule = new waf.CfnRuleGroup(this, "wafRuleGroupCdn", {
      name: "cdnOnly",
      capacity: 2,
      scope: "REGIONAL",
      visibilityConfig: vcNoLogging,
      rules: [
        {
          name: "denyNoKey",
          priority: 0,
          action: {
            block: {},
          },
          statement: {
            notStatement: {
              statement: {
                byteMatchStatement: {
                  searchString: albKeyValue,
                  fieldToMatch: {
                    singleHeader: {
                      name: albKeyName,
                    },
                  },
                  positionalConstraint: "EXACTLY",
                  textTransformations: [
                    {
                      priority: 0,
                      type: "NONE",
                    },
                  ],
                },
              },
            },
          },
          visibilityConfig: vcNoLogging,
        },
      ],
    });

    const customRules = [
      ["owner", ownerRule.attrArn],
      ["cdnOnly", cdnOnlyRule.attrArn],
    ];
    if (isOwnerOnly) {
      customRules.push(["ownerOnly", ownerOnlyRule.attrArn]);
    }
    const managedRules = [
      "AWSManagedRulesAmazonIpReputationList",
      "AWSManagedRulesAnonymousIpList",
      "AWSManagedRulesCommonRuleSet",
      "AWSManagedRulesWordPressRuleSet",
      "AWSManagedRulesPHPRuleSet",
      "AWSManagedRulesSQLiRuleSet",
      "AWSManagedRulesLinuxRuleSet",
      "AWSManagedRulesUnixRuleSet",
    ];

    const acl = new waf.CfnWebACL(this, "wafACL", {
      defaultAction: {
        allow: {},
      },
      scope: "REGIONAL",
      visibilityConfig: vcNoLogging,
      rules: [
        ...customRules.map((values, i) => ({
          name: values[0],
          priority: i,
          overrideAction: { none: {} },
          statement: {
            ruleGroupReferenceStatement: {
              arn: values[1],
            },
          },
          visibilityConfig: visibilityConfig(values[0]),
        })),

        ...managedRules.map((name, i) => ({
          name,
          priority: i + Object.keys(customRules).length,
          overrideAction: { none: {} },
          statement: {
            managedRuleGroupStatement: {
              vendorName: "AWS",
              name: name,
            },
          },
          visibilityConfig: visibilityConfig(name),
        })),
      ],
    });

    new waf.CfnWebACLAssociation(this, "wafAssociation", {
      resourceArn: albArn,
      webAclArn: acl.attrArn,
    });
  }

  createCloudfront(
    certArn: string,
    albDomain: string,
    albKeyName: string,
    albKeyValue: string
  ) {
    // MEMO: CNAMEは証明書が正しい必要があるため、別途AWSコンソールから指定する
    new cloudfront.CloudFrontWebDistribution(this, "cdnDistribution", {
      viewerCertificate: cloudfront.ViewerCertificate.fromAcmCertificate(
        acm.Certificate.fromCertificateArn(this, "acmCdnCert", certArn)
      ),
      viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      priceClass: cloudfront.PriceClass.PRICE_CLASS_ALL,
      originConfigs: [
        {
          customOriginSource: {
            domainName: albDomain,
          },
          behaviors: [
            {
              isDefaultBehavior: true,
              // MEMO: TTLは要件・コンテンツに合わせて要調整
              defaultTtl: cdk.Duration.days(1),
              minTtl: cdk.Duration.minutes(1),
              maxTtl: cdk.Duration.days(3),
            },
          ],
          originHeaders: {
            [albKeyName]: albKeyValue,
          },
        },
      ],
    });
  }
}
